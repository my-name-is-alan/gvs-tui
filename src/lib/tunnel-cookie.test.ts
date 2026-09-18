import {test,expect} from 'bun:test'
import {localFetch} from './tunnel.ts'
test('tunnel preserves redirect and separate login cookies',async()=>{
 let followed=false
 const server=Bun.serve({port:0,fetch(req){if(new URL(req.url).pathname==='/next'){followed=true;return new Response('unexpected')};const h=new Headers({Location:'/next'});h.append('Set-Cookie','first=1; Path=/');h.append('Set-Cookie','qrsig=TEST; Path=/');return new Response(null,{status:302,headers:h})}})
 try {const r=await localFetch({t:'req',id:'test',url:server.url.toString(),method:'GET'});expect(r.status).toBe(302);expect(followed).toBe(false);expect(r.header?.['set-cookie']).toHaveLength(2)}finally{server.stop()}
})
