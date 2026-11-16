import { jwt,IDENTITY } from './runtime.mjs';
if(typeof process.send === 'function'){
process.send({ready:true});
process.once('message',async config=>{
 try{
  const {base,path,role,token,body,method='POST',offset=0,runId='123',headers={}}=config;
  const h={...headers,'Content-Type':'application/json'};
  if(role)h.Authorization='Bearer '+await jwt(role,runId,'1',offset);else {h.Authorization='Bearer '+token;h.Origin='https://marcogusmao.github.io';}
  const res=await fetch(base+(role?'/api/internal/v1/friend-a':'/api/v1/friend-a')+path,{method,headers:h,body:method==='GET'?undefined:JSON.stringify(body||IDENTITY)});
  const text=await res.text();process.send({status:res.status,body:text?JSON.parse(text):null});
 }catch(e){process.send({error:String(e)});process.exitCode=1;}
 process.disconnect();
});

}else{
 const {test}=await import('node:test');test.skip('HTTP race client requires an IPC parent',()=>{});
}
