// Independent process proof for the production SQL queries, without a listening socket.
// Does not replace workerd acceptance: node:sqlite supplies the SQL adapter here.
import {rig} from './sqlite.js';
if(typeof process.send === 'function'){
const r=await rig({path:process.argv[2],resume:true,clock:Number(process.argv[3])});
process.send({ready:true});
process.once('message',async ({name,body,p={},actor,receipts})=>{
 try{
  if(receipts)r.receipts=new Map(Object.entries(receipts));
  const result=name==='ack'?await r.state.acknowledge('ack',p.revision,body,actor):r.call(name,body,p,actor);
  process.send({status:result[0],body:result[1]});
 }catch(e){process.send({status:e.status||500,code:e.code||'SQL_ERROR'});}
 finally{r.ctx.db.close();process.disconnect();}
});

}else{
 const {test}=await import('node:test');test.skip('SQLite race client requires an IPC parent',()=>{});
}
