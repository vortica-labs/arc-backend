'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const INDEX = 'sha256:d79ee5405c91dee9fc373e0e4006625f53cf9b2e2c40f119f3237a82127c7756';
const CHILD = 'sha256:187a2d6976557aee6ebb67238b18902677cb961aadc5572e02595769a0d3b908';
const SOURCE = '7210a79c3c4b7ed4d46ccecdfa58f8f89c2c55bf8328d08c30d6ec182cdff86f';
const REVISION = '8da99f7272b68e5909314fb7dea7be7328b45be2';
const LOCAL = 'squadhunt-story-api:20261103';
const REGISTRY = '906446637180.dkr.ecr.us-east-1.amazonaws.com';
const TAG = 'pi-story-overlays-api-r1-20261103';
const IMAGE = REGISTRY + '/arc-backend:' + TAG;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function validateRegistry(raw, expectedIndex, expectedChild) {
  const index=JSON.parse(raw), candidates=[raw,raw.at(-1)===10?raw.subarray(0,-1):raw];
  const children=index.manifests?.filter(m=>m.platform?.os==='linux'&&m.platform?.architecture==='amd64');
  if (!candidates.some(b=>'sha256:'+sha(b)===expectedIndex) || index.mediaType!=='application/vnd.oci.image.index.v1+json' || children?.length!==1 || children[0].digest!==expectedChild) throw Error('REGISTRY_MISMATCH');
}

function publish({ command = spawnSync, platform = process.platform, localAppData = process.env.LOCALAPPDATA, cwd = process.cwd() } = {}) {
  if (platform !== 'win32' || !localAppData) throw Error('WINDOWS_DOCKER_LAPTOP_REQUIRED');
  const directory = path.join(localAppData, 'SquadHuntRelease', 'story-api-publish-r1-consumed');
  if (fs.existsSync(directory)) throw Error('ALREADY_CONSUMED_NO_RETRY');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AWS_')));
  Object.assign(env, { AWS_MAX_ATTEMPTS:'1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:'true', AWS_PAGER:'', AWS_CLI_AUTO_PROMPT:'off' });
  const invoke = (exe, args, extra = {}) => {
    const result = command(exe, args, { cwd, env, encoding:'utf8', timeout:30000, maxBuffer:1048576, ...extra });
    if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string') throw Error('COMMAND_FAILED_OR_UNKNOWN');
    return result.stdout;
  };
  const docker = (args, extra) => invoke('docker', ['--context','desktop-linux',...args], extra);
  const awsArgs = args => [...args,'--profile','default','--region','us-east-1','--no-paginate','--cli-connect-timeout','10','--cli-read-timeout','25'];
  // Read-only local checks precede journal consumption and every AWS request.
  const metadata = JSON.parse(fs.readFileSync(path.join(cwd,'story-api-build-metadata.json')));
  if (metadata['containerimage.digest'] !== INDEX) throw Error('BUILD_METADATA_MISMATCH');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(cwd,'../arc-story-api-context/.source-manifest.json')));
  if (manifest.sourceContentSha256 !== SOURCE || sha(JSON.stringify(manifest.files)) !== SOURCE) throw Error('SOURCE_MISMATCH');
  const images = JSON.parse(docker(['image','inspect',LOCAL]));
  if (images.length !== 1 || images[0].Id !== INDEX || images[0].Os !== 'linux' || images[0].Architecture !== 'amd64' || images[0].Config?.Labels?.['org.opencontainers.image.revision'] !== REVISION) throw Error('LOCAL_IMAGE_MISMATCH');
  fs.mkdirSync(path.dirname(directory), { recursive:true });
  fs.mkdirSync(directory);
  const save = (name, value) => {
    const file = path.join(directory,name), bytes = Buffer.from(JSON.stringify(value,null,2)+'\n');
    const fd = fs.openSync(file,'wx',0o600);
    try { fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (!fs.readFileSync(file).equals(bytes)) throw Error('JOURNAL_WRITE_UNKNOWN');
  };
  let status='CLOSED_HOLD', stage='APPROVAL', awsAttempts=0, pushes=0, registryReads=0, reason=null;
  const intent = (name, details) => save(name+'.json',{at:Date.now(),...details});
  const aws = (name,args) => { intent(name,{attempt:1,args}); awsAttempts++; return invoke('aws',awsArgs(args)); };
  try {
    intent('approval',{decision:'APPROVE_EXACT_EXISTING_STORY_IMAGE_ECR_PUBLICATION_ONLY',image:IMAGE,indexDigest:INDEX,amd64ChildDigest:CHILD,sourceContentSha256:SOURCE,builds:0,ecsAuthority:0});
    stage='IDENTITY';
    const who=JSON.parse(aws('identity-intent',['sts','get-caller-identity','--output','json']));
    if (who.Account!=='906446637180' || who.Arn!=='arn:aws:iam::906446637180:root') throw Error('CALLER_MISMATCH');
    stage='TAG_ABSENCE';
    const args=awsArgs(['ecr','describe-images','--registry-id','906446637180','--repository-name','arc-backend','--image-ids','imageTag='+TAG,'--output','json']);
    intent('absence-intent',{attempt:1,args});awsAttempts++;
    const absent=command('aws',args,{cwd,env,encoding:'utf8',timeout:30000,maxBuffer:1048576});
    if (absent.error || absent.signal || absent.status===0 || !Number.isInteger(absent.status) || !/\(ImageNotFoundException\)/.test(String(absent.stderr||''))) throw Error('TAG_NOT_POSITIVELY_ABSENT');
    const absenceAt=Date.now();intent('tag-absent',{image:IMAGE,absent:true});
    stage='LOGIN';
    const password=aws('authentication-intent',['ecr','get-login-password']);
    intent('docker-login-intent',{registry:REGISTRY,passwordStdin:true});
    docker(['login','--username','AWS','--password-stdin',REGISTRY],{input:password});
    stage='LOCAL_TAG';intent('local-tag-intent',{source:INDEX,destination:IMAGE});
    docker(['tag',INDEX,IMAGE]);
    if (Date.now()-absenceAt>=300000) throw Error('TAG_ABSENCE_STALE');
    stage='PUSH';intent('push-intent',{image:IMAGE,indexDigest:INDEX,attempt:1});pushes++;
    const ack=docker(['push',IMAGE],{timeout:900000});
    const digests=[...ack.matchAll(/digest:\s*(sha256:[a-f0-9]{64})/g)].map(m=>m[1]);
    if (digests.length!==1 || digests[0]!==INDEX) throw Error('PUSH_ACK_MISMATCH_OR_UNKNOWN');
    intent('push-ack',{indexDigest:INDEX});
    stage='REGISTRY_VERIFY';intent('registry-intent',{image:REGISTRY+'/arc-backend@'+INDEX,attempt:1});registryReads++;
    const raw=Buffer.from(docker(['buildx','imagetools','inspect','--raw',REGISTRY+'/arc-backend@'+INDEX]));
    validateRegistry(raw,INDEX,CHILD);
    intent('artifact-receipt',{image:IMAGE,indexDigest:INDEX,amd64ChildDigest:CHILD,sourceContentSha256:SOURCE,sourceRevisionLabel:REVISION,builds:0,ecsAuthority:0});
    status='CLOSED_STORY_IMAGE_PUBLISHED_NO_DEPLOYMENT';stage='RECEIPT';
  } catch(error) {
    const allowed=['COMMAND_FAILED_OR_UNKNOWN','JOURNAL_WRITE_UNKNOWN','CALLER_MISMATCH','TAG_NOT_POSITIVELY_ABSENT','TAG_ABSENCE_STALE','PUSH_ACK_MISMATCH_OR_UNKNOWN','REGISTRY_MISMATCH'];
    reason=allowed.includes(error.message)?error.message:'UNKNOWN_LOCAL_OR_PROVIDER_RESULT';
  } finally {
    save('authority-closed.json',{at:Date.now(),status,stage,reason,awsAttempts,pushes,registryReads,builds:0,remainingAwsAttempts:0,remainingPushes:0,remainingRegistryReads:0,ecsAuthority:0});
  }
  const result={status,stage,reason,awsAttempts,pushes,registryReads,builds:0,journal:directory};
  if(status==='CLOSED_STORY_IMAGE_PUBLISHED_NO_DEPLOYMENT') Object.assign(result,{image:IMAGE,indexDigest:INDEX,amd64ChildDigest:CHILD});
  return result;
}
module.exports={publish,validateRegistry};
if(require.main===module) {
  try { const result=publish();console.log(JSON.stringify(result,null,2));if(result.status==='CLOSED_HOLD')process.exitCode=1; }
  catch(error) { const codes=['WINDOWS_DOCKER_LAPTOP_REQUIRED','ALREADY_CONSUMED_NO_RETRY','BUILD_METADATA_MISMATCH','SOURCE_MISMATCH','LOCAL_IMAGE_MISMATCH'];console.error(codes.includes(error.message)?error.message:'EXECUTION_STOPPED_CHECK_JOURNAL_NO_RETRY');process.exitCode=1; }
}
