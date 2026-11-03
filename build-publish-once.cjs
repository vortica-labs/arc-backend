'use strict';
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), zlib=require('node:zlib');
const {spawnSync}=require('node:child_process');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const ROOT=__dirname, RUN='pi-story-reliability-api-r1-20261103';
const ARCHIVE='cac90dc8a889c7658faee950dadf8d61946b9f341cee8d6f52089a299372c627';
const SOURCE='fcf841136a2a07793ed57091a19d58ffa3e6dd3de5f52172eaa415e627c1312f';
const FILES='abf16ed90917dcf7fa5d720167269641a146618bbf2634c95b4ad1c51739cc52';
const REPO='906446637180.dkr.ecr.us-east-1.amazonaws.com/arc-backend';
function check(ok,code){if(!ok)throw Error(code);}
function unpack(raw){
  check(sha(raw)===ARCHIVE,'ARCHIVE_CHANGED');
  const data=JSON.parse(zlib.gunzipSync(raw,{maxOutputLength:40000000}));
  check(sha(JSON.stringify(data.sha256))===FILES,'MANIFEST_CHANGED');
  check(Object.keys(data.files).length===767&&Object.keys(data.sha256).length===767,'FILE_SET_CHANGED');
  const rows=[];
  for(const [name,digest] of Object.entries(data.sha256)){
    check(/^[a-zA-Z0-9_./-]+$/.test(name)&&!name.startsWith('/')&&!name.split('/').some(x=>!x||x==='.'||x==='..'),'ARCHIVE_PATH_REJECTED');
    check(typeof data.files[name]==='string','ARCHIVE_RECORD_REJECTED');
    const bytes=Buffer.from(data.files[name],'base64');
    check(sha(bytes)===digest,'SOURCE_BYTES_CHANGED');rows.push([name,bytes]);
  }
  return rows;
}
function parseBuilder(raw){
  const p=raw.replace(/\r\n/g,'\n').split(/^\s*Nodes:\s*$/m);
  check(p.length===2,'BUILDER_NODES_INVALID');
  const get=(s,k)=>{const a=[...s.matchAll(new RegExp('^'+k+':[ \\t]*(.*)$','gm'))];check(a.length===1,'BUILDER_FIELD_INVALID');return a[0][1].trim();};
  const b={name:get(p[0],'Name'),driver:get(p[0],'Driver'),node:get(p[1],'Name'),endpoint:get(p[1],'Endpoint'),status:get(p[1],'Status'),platforms:get(p[1],'Platforms')};
  check(b.name==='desktop-linux'&&['docker','docker-container'].includes(b.driver)&&b.node==='desktop-linux'&&b.endpoint==='desktop-linux'&&b.status==='running'&&/(?:^|,\s*)linux\/amd64(?:\*|,|$)/.test(b.platforms),'EXISTING_LOCAL_BUILDER_REQUIRED');return b;
}
function registry(raw,digest){
  const index=JSON.parse(raw),a=index.manifests?.filter(m=>m.platform?.os==='linux'&&m.platform?.architecture==='amd64');
  check(['sha256:'+sha(raw),'sha256:'+sha(raw.at(-1)===10?raw.subarray(0,-1):raw)].includes(digest),'INDEX_DIGEST_MISMATCH');
  check(index.mediaType==='application/vnd.oci.image.index.v1+json'&&a?.length===1&&/^sha256:[a-f0-9]{64}$/.test(a[0].digest),'AMD64_MANIFEST_INVALID');return a[0].digest;
}
function execute(){
  check(process.platform==='win32'&&process.env.LOCALAPPDATA,'WINDOWS_DOCKER_LAPTOP_REQUIRED');
  const plan=JSON.parse(fs.readFileSync(path.join(ROOT,'build-plan.json')));
  check(plan.runId===RUN&&plan.tag===RUN&&plan.repository===REPO&&plan.sourceContentSha256===SOURCE&&plan.archiveSha256===ARCHIVE,'PLAN_CHANGED');
  const rows=unpack(fs.readFileSync(path.join(ROOT,'source.json.gz')));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('AWS_')));
  Object.assign(env,{AWS_MAX_ATTEMPTS:'1',AWS_IGNORE_CONFIGURED_ENDPOINT_URLS:'true',AWS_PAGER:'',AWS_CLI_AUTO_PROMPT:'off'});
  const invoke=(exe,args,options={})=>{const r=spawnSync(exe,args,{cwd:ROOT,env,encoding:'utf8',timeout:30000,maxBuffer:1048576,...options});check(!r.error&&!r.signal&&r.status===0,'COMMAND_FAILED_OR_UNKNOWN');return r.stdout;};
  const docker=(args,options)=>invoke('docker',['--context','desktop-linux',...args],options);
  const revision=invoke('git',['rev-parse','HEAD']).trim();check(/^[a-f0-9]{40}$/.test(revision),'CARRIER_REVISION_INVALID');
  const host=JSON.parse(docker(['context','inspect','desktop-linux','--format','{{json .Endpoints.docker.Host}}']));
  check(typeof host==='string'&&host.startsWith('npipe:'),'LOCAL_NAMED_PIPE_REQUIRED');
  const builder=parseBuilder(docker(['buildx','inspect','desktop-linux']));
  const journal=path.join(process.env.LOCALAPPDATA,'SquadHuntRelease',RUN+'-consumed');
  check(!fs.existsSync(journal),'ALREADY_CONSUMED_NO_RETRY');fs.mkdirSync(path.dirname(journal),{recursive:true});fs.mkdirSync(journal);
  const save=(name,value)=>{const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),f=path.join(journal,name+'.json'),fd=fs.openSync(f,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}check(fs.readFileSync(f).equals(bytes),'JOURNAL_WRITE_UNKNOWN');};
  const awsArgs=args=>[...args,'--profile','default','--region','us-east-1','--no-paginate','--cli-connect-timeout','10','--cli-read-timeout','25'];
  let stage='RECEIPT',status='CLOSED_HOLD',reason=null,awsAttempts=0,builds=0,registryReads=0,artifact=null;
  const aws=(name,args)=>{save(name+'-intent',{at:Date.now(),attempt:1,operation:args.slice(0,2)});awsAttempts++;return invoke('aws',awsArgs(args));};
  try{
    save('consumed',{at:Date.now(),request:'deploy web and backend',runId:RUN,sourceContentSha256:SOURCE,archiveSha256:ARCHIVE,builder,ecsAuthority:0});
    const context=path.join(journal,'context');fs.mkdirSync(context);
    for(const [name,bytes] of rows){const f=path.join(context,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,bytes,{flag:'wx'});check(sha(fs.readFileSync(f))===sha(bytes),'CONTEXT_WRITE_UNKNOWN');}
    stage='IDENTITY';const who=JSON.parse(aws('identity',['sts','get-caller-identity','--output','json']));
    check(who.Account==='906446637180'&&who.Arn==='arn:aws:iam::906446637180:root','CALLER_CHANGED');
    stage='TAG_ABSENCE';save('tag-absence-intent',{at:Date.now(),tag:RUN,attempt:1});awsAttempts++;
    const r=spawnSync('aws',awsArgs(['ecr','describe-images','--registry-id','906446637180','--repository-name','arc-backend','--image-ids','imageTag='+RUN,'--output','json']),{env,encoding:'utf8',timeout:30000,maxBuffer:1048576});
    check(!r.error&&!r.signal&&r.status!==null&&r.status!==0&&/\(ImageNotFoundException\)/.test(r.stderr||''),'TAG_NOT_POSITIVELY_ABSENT');const absenceAt=Date.now();
    stage='LOGIN';const password=aws('authentication',['ecr','get-login-password']);save('login-intent',{at:Date.now(),passwordStdin:true});docker(['login','--username','AWS','--password-stdin',REPO.split('/')[0]],{input:password});
    check(Date.now()-absenceAt<300000,'TAG_EVIDENCE_STALE');
    stage='BUILD_PUSH';save('build-push-intent',{at:Date.now(),image:REPO+':'+RUN,archiveSha256:ARCHIVE,attempt:1});builds++;
    const metadata=path.join(journal,'metadata.json');
    docker(['buildx','build','--builder','desktop-linux','--platform','linux/amd64','--provenance=mode=min','--output=type=registry,oci-mediatypes=true','--metadata-file',metadata,'--build-arg','SOURCE_REVISION='+revision,'--build-arg','SOURCE_REPOSITORY=https://github.com/vortica-labs/arc-backend','--label','com.squadhunt.api.source-content='+SOURCE,'-t',REPO+':'+RUN,context],{timeout:900000});
    stage='BUILD_ACK';check(fs.statSync(metadata).size<1048576,'BUILD_METADATA_INVALID');const m=JSON.parse(fs.readFileSync(metadata)),digest=m['containerimage.digest'];check(/^sha256:[a-f0-9]{64}$/.test(digest||''),'BUILD_ACK_UNKNOWN');save('build-ack',{at:Date.now(),indexDigest:digest});
    stage='REGISTRY';save('registry-intent',{at:Date.now(),indexDigest:digest,attempt:1});registryReads++;
    const raw=Buffer.from(docker(['buildx','imagetools','inspect','--raw',REPO+'@'+digest]));const child=registry(raw,digest);
    artifact={at:Date.now(),runId:RUN,image:REPO+':'+RUN,indexDigest:digest,amd64ChildDigest:child,sourceContentSha256:SOURCE,archiveSha256:ARCHIVE,carrierRevision:revision,ecsAuthority:0};save('artifact-receipt',artifact);status='CLOSED_API_IMAGE_PUBLISHED_NO_DEPLOYMENT';stage='RECEIPT';
  }catch(e){reason=/^[A-Z0-9_]+$/.test(e.message)?e.message:'UNKNOWN_LOCAL_OR_PROVIDER_OUTCOME';}
  finally{save('authority-closed',{at:Date.now(),status,stage,reason,awsAttempts,builds,registryReads,remainingBuilds:0,remainingPushes:0,remainingReads:0,ecsAuthority:0});}
  console.log(JSON.stringify({status,stage,reason,journal,awsAttempts,builds,registryReads,...(artifact?{artifact}:{})},null,2));if(reason)process.exitCode=1;
}
module.exports={unpack,parseBuilder,registry};
if(require.main===module){try{execute();}catch(e){console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'LOCAL_PRECHECK_FAILED_NO_AWS');process.exitCode=1;}}
