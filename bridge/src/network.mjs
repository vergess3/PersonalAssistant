import {Agent,setGlobalDispatcher,fetch as undiciFetch} from 'undici';
import {DirectHttp} from './direct-http.mjs';
let direct;
export const fetch=(url,options)=>direct?direct.fetch(url,options):undiciFetch(url,options);
export function configureHttp(network){
  if(network?.mode==='physical-direct'){
    direct=new DirectHttp(network);return direct;
  }
  direct=undefined;
  // Use fetch and its dispatcher from the same pinned library version.
  // No proxy override: retain the host's existing routing.
  const agent=new Agent({connect:{timeout:30000}});setGlobalDispatcher(agent);return agent;
}
