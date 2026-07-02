#!/usr/bin/env bash
# Usage: bash deploy.sh
# Builds, pushes to ECR, registers a new task definition, and deploys to ECS.

set -euo pipefail

ACCOUNT_ID="906446637180"
REGION="us-east-1"
REPO="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/arc-backend"
CLUSTER="arc-cluster"
SERVICE="arc-backend"
TASK_FAMILY="arc-backend"

# Git short SHA as image tag (fallback: timestamp)
TAG=$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)
IMAGE="$REPO:$TAG"

echo "==> Tag: $TAG"

# 1. Fail before publishing an image if channel policy or notification
# producers regress. The artifact check runs after compilation and compares
# canonical source with the generated worker tree used by the image.
echo "==> Running notification and email policy release gates..."
npm run test:notification-policy
npm run test:notification-producers
npm run typecheck
npm run build
npm run verify:email-policy-release

# 2. ECR login
echo "==> ECR login..."
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

# 3. Build
echo "==> Building image..."
docker build --platform linux/amd64 -t "$IMAGE" .

# 4. Push
echo "==> Pushing to ECR..."
docker push "$IMAGE"

# 5. Fetch latest task definition, swap image, strip read-only fields
echo "==> Registering new task definition..."
aws ecs describe-task-definition --task-definition "$TASK_FAMILY" \
  --query 'taskDefinition' --output json | \
  node -e "
    const chunks = [];
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => {
      const td = JSON.parse(chunks.join(''));
      td.containerDefinitions[0].image = process.argv[1];
      ['taskDefinitionArn','revision','status','requiresAttributes',
       'compatibilities','registeredAt','registeredBy'].forEach(k => delete td[k]);
      process.stdout.write(JSON.stringify(td));
    });
  " "$IMAGE" > ./arc-task-def.json

NEW_REV=$(aws ecs register-task-definition \
  --cli-input-json file://./arc-task-def.json \
  --query 'taskDefinition.revision' --output text)
echo "==> Task definition: $TASK_FAMILY:$NEW_REV"

# 6. Run provider credential verification, email-policy artifact verification,
# and additive push migrations inside
# the new image, with the same secrets/network as the service. A failed
# preflight prevents the broken revision from receiving production traffic.
echo "==> Running push provider and database preflight..."
NETWORK_CONFIGURATION=$(aws ecs describe-services \
  --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].networkConfiguration' --output json)
CONTAINER_NAME=$(aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY:$NEW_REV" \
  --query 'taskDefinition.containerDefinitions[0].name' --output text)
OVERRIDES=$(node -e "process.stdout.write(JSON.stringify({containerOverrides:[{name:process.argv[1],command:['node','scripts/preflight-push-release.js']}]}))" "$CONTAINER_NAME")
PREFLIGHT_TASK=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_FAMILY:$NEW_REV" \
  --launch-type FARGATE \
  --network-configuration "$NETWORK_CONFIGURATION" \
  --overrides "$OVERRIDES" \
  --query 'tasks[0].taskArn' --output text)
if [[ -z "$PREFLIGHT_TASK" || "$PREFLIGHT_TASK" == "None" ]]; then
  echo "Push preflight task could not be started" >&2
  exit 1
fi
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$PREFLIGHT_TASK"
PREFLIGHT_EXIT=$(aws ecs describe-tasks \
  --cluster "$CLUSTER" --tasks "$PREFLIGHT_TASK" \
  --query 'tasks[0].containers[0].exitCode' --output text)
if [[ "$PREFLIGHT_EXIT" != "0" ]]; then
  PREFLIGHT_REASON=$(aws ecs describe-tasks \
    --cluster "$CLUSTER" --tasks "$PREFLIGHT_TASK" \
    --query 'tasks[0].containers[0].reason' --output text)
  echo "Push preflight failed (exit=$PREFLIGHT_EXIT): $PREFLIGHT_REASON" >&2
  exit 1
fi

# 7. Deploy
echo "==> Updating ECS service..."
aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$SERVICE" \
  --task-definition "$TASK_FAMILY:$NEW_REV" \
  --force-new-deployment \
  --output table \
  --query 'service.{taskDef:taskDefinition,running:runningCount,pending:pendingCount}'

# 8. Wait
echo "==> Waiting for stable deployment (~2 min)..."
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"

# 9. A healthy rolling deployment is not sufficient for an email-policy
# release: every queue consumer must be on the new revision and image digest.
echo "==> Verifying running ECS tasks use the new policy revision..."
RUNNING_TASKS=$(aws ecs list-tasks \
  --cluster "$CLUSTER" \
  --service-name "$SERVICE" \
  --desired-status RUNNING \
  --query 'taskArns' --output text)
if [[ -z "$RUNNING_TASKS" || "$RUNNING_TASKS" == "None" ]]; then
  echo "No running ECS service tasks were found after deployment" >&2
  exit 1
fi
EXPECTED_TASK_DEF=$(aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY:$NEW_REV" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
EXPECTED_DIGEST=$(aws ecr describe-images \
  --repository-name arc-backend \
  --image-ids imageTag="$TAG" \
  --query 'imageDetails[0].imageDigest' --output text)
RUNNING_TASK_DEFS=$(aws ecs describe-tasks \
  --cluster "$CLUSTER" \
  --tasks $RUNNING_TASKS \
  --query 'tasks[].taskDefinitionArn' --output text)
RUNNING_DIGESTS=$(aws ecs describe-tasks \
  --cluster "$CLUSTER" \
  --tasks $RUNNING_TASKS \
  --query 'tasks[].containers[0].imageDigest' --output text)
for task_def in $RUNNING_TASK_DEFS; do
  if [[ "$task_def" != "$EXPECTED_TASK_DEF" ]]; then
    echo "Old ECS task revision is still consuming queues: $task_def" >&2
    exit 1
  fi
done
for digest in $RUNNING_DIGESTS; do
  if [[ "$digest" != "$EXPECTED_DIGEST" ]]; then
    echo "Unexpected ECS image digest is still running: $digest" >&2
    exit 1
  fi
done
echo "==> Verified task revision $TASK_FAMILY:$NEW_REV and digest $EXPECTED_DIGEST"

echo ""
rm -f ./arc-task-def.json
echo "Done! Image=$IMAGE  TaskDef=$TASK_FAMILY:$NEW_REV"
echo "Health: https://api.squadhunt.in/health"
