import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
if(process.env.OWNED_PROMPT_FILE)writeFileSync(process.env.OWNED_PROMPT_FILE,prompt);
if(process.env.CODEX_CHANNEL_EXECUTION_DIR || process.env.CODEX_CHANNEL_EXECUTION_TOKEN)throw Error('Control credentials leaked to CLI');
if(process.env.OWNED_MODE==='descendant'){
  writeFileSync(process.env.OWNED_PARENT_PID_FILE,String(process.pid));
  const child=spawn(process.execPath,['--input-type=module','-e',
    "import {writeFileSync,appendFileSync} from 'node:fs';writeFileSync(process.env.OWNED_PID_FILE,String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>appendFileSync(process.env.OWNED_EFFECT_FILE,'x'),20);"],{stdio:'ignore',env:process.env});
  child.unref();process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
}else{
  console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));
  if(process.env.OWNED_MODE==='failure'){
    console.log(JSON.stringify({type:'item.completed',item:{id:'tool',type:'command_execution',command:'synthetic',aggregated_output:'',exit_code:0,status:'completed'}}));
    console.log(JSON.stringify({type:'turn.failed',error:{message:'synthetic model failure'}}));
    process.exitCode=1;
  }else{
    console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'synthetic answer'}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));
  }
}
