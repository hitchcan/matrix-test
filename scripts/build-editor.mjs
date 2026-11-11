import {build} from 'esbuild';
await build({entryPoints:['public/rich-editor.js'],bundle:true,format:'esm',outfile:'public/editor.bundle.js',minify:true});
