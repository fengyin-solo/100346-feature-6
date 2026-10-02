// verify 的打包入口：直接调 esbuild 的 JS API，绕过仓库里为其它平台安装的二进制。
import { build } from 'esbuild'

await build({
  entryPoints: ['verify-logic.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: '.verify-bundle.mjs',
  logLevel: 'warning',
})
