#!/usr/bin/env bash
# 把当前 dist/ 发布到 gh-pages 分支（GitHub Pages 以该分支根目录为站点）。
# 用法：npm run deploy:pages
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ORIGIN="$(git remote get-url origin)"
BRANCH="gh-pages"

npm run build

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -R dist/. "$TMP"/
touch "$TMP/.nojekyll"          # 关闭 Jekyll，避免以下划线开头的资源被忽略

cd "$TMP"
git init -q -b "$BRANCH"
git add -A
git -c user.name="let5sne" -c user.email="let5sne@gmail.com" \
  commit -q -m "deploy: GitHub Pages build $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git remote add origin "$ORIGIN"
git push -f -q origin "$BRANCH"

echo "已推送 $BRANCH，稍候访问 https://let5sne.github.io/sanguozhi-3d-strategy/"
