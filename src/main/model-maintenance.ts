/** Caller holds queue maintenance and has verified both queues are idle. */
export async function withPausedModelEngine<T>(
 backend:{status():{state:string};stop():Promise<void>}, operation:()=>Promise<T>,
 refresh:()=>Promise<unknown>, restart:()=>Promise<void>, restartFailed:(error:unknown)=>void,
):Promise<T> {
 const wasRunning=backend.status().state==='ready';
 if(wasRunning)await backend.stop();
 try{return await operation();}
 finally {
   try{await refresh();}
   finally {if(wasRunning){try{await restart();}catch(error){restartFailed(error);}}}
 }
}
