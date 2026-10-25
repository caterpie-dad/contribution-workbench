import {EnvHttpProxyAgent,setGlobalDispatcher} from 'undici';
const proxy=process.env.http_proxy||process.env.HTTP_PROXY||process.env.https_proxy||process.env.HTTPS_PROXY;
export const proxyConfigured=!!proxy;
if(proxy){const bypass=[process.env.no_proxy||process.env.NO_PROXY||'','localhost','127.0.0.1'].filter(Boolean).join(',');process.env.NO_PROXY=bypass;process.env.no_proxy=bypass;setGlobalDispatcher(new EnvHttpProxyAgent({noProxy:bypass}));}
