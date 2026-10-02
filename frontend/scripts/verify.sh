#!/bin/sh
# 纯前端项目没有后端：用 Node + 内存 localStorage 跑业务断言（林场权限/接令仲裁/幂等/调岗留痕）。
node scripts/verify-build.mjs
node .verify-bundle.mjs
status=$?
rm -f .verify-bundle.mjs
exit $status
