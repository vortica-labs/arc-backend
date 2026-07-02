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

# 1. ECR login
echo "==> ECR login..."
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

# 2. Build
echo "==> Building image..."
docker build --platform linux/amd64 -t "$IMAGE" .

# 3. Push
echo "==> Pushing to ECR..."
docker push "$IMAGE"

# 4. Fetch latest task definition, swap image, strip read-only fields
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

# 5. Run provider credential verification and additive push migrations inside
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

# 6. Deploy
echo "==> Updating ECS service..."
aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$SERVICE" \
  --task-definition "$TASK_FAMILY:$NEW_REV" \
  --force-new-deployment \
  --output table \
  --query 'service.{taskDef:taskDefinition,running:runningCount,pending:pendingCount}'

# 7. Wait
echo "==> Waiting for stable deployment (~2 min)..."
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"

echo ""
rm -f ./arc-task-def.json
echo "Done! Image=$IMAGE  TaskDef=$TASK_FAMILY:$NEW_REV"
echo "Health: https://api.squadhunt.in/health"
