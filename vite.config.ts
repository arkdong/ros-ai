import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
// Two pages: the app (index.html) and the landing page (landing.html), which the public demo serves at /.
export default defineConfig({plugins:[react()],build:{outDir:'dist/client',rollupOptions:{input:{main:resolve(__dirname,'index.html'),landing:resolve(__dirname,'landing.html')}}},server:{host:'127.0.0.1'}});
