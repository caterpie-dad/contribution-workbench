import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
const server=new McpServer({name:'wiki-contract-fixture',version:'1.0.0'});
server.registerTool('read_page',{inputSchema:{page_id:z.string(),version:z.number().optional()}},async({page_id,version})=>({content:[{type:'text',text:JSON.stringify({id:page_id,title:'MCP evidence',body:'<p>Actual MCP protocol response evidence.</p>',version:Number(version||2),date:'2025-02-01T00:00:00Z',actor:'analyst',url:'https://wiki.test/pages/'+page_id})}]}));
server.registerTool('list_items',{inputSchema:{operation:z.string(),page_id:z.string(),cursor:z.string().optional()}},async({operation,cursor})=>({content:[{type:'text',text:JSON.stringify(operation==='children'?{items:cursor?[]:[{id:'2'}],next:cursor?null:'next-page'}:operation==='versions'?{items:[{number:2,when:'2025-02-01T00:00:00Z'}],next:null}:{items:[],next:null})}]}));
await server.connect(new StdioServerTransport());
