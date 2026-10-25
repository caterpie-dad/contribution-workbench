import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests/browser',timeout:60000,workers:1,use:{baseURL:process.env.DASHBOARD_URL||'http://127.0.0.1:3100',viewport:{width:1440,height:1000},trace:'retain-on-failure'},reporter:[['list'],['html',{open:'never'}]]});
