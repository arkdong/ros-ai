import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// app-check.html is the page ros_check_app opens to try an App the way the canvas runs it.
export default defineConfig({plugins:[react()],build:{outDir:'dist/client',rollupOptions:{input:{main:'index.html',check:'app-check.html'}}},server:{host:'127.0.0.1'}});
