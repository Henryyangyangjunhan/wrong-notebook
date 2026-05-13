# 自定义功能更新说明

所有自定义功能位于 `custom/stable-features` 分支。

## 远程仓库配置

- `origin` → 你的 Fork：`Henryyangyangjunhan/wrong-notebook`（Token 认证）
- `upstream` → 官方仓库：`wttwins/wrong-notebook`（通过 gh-proxy 镜像）

## 包含的自定义功能

1. **筛选按钮修复** — 章节和知识点下拉在有数据时始终可点击，不再因选择"全部"而变灰
2. **图片尺寸保留** — 打印预览图片缩放滑块 (30%-100%)、详情页全宽图片查看器、压缩逻辑等
3. **随机排列打印** — 打印预览页新增「随机排列」复选框，Fisher-Yates 洗牌，原题号保留

## 官方仓库更新后同步并部署

```bash
cd /home/ubuntu/wrong_notebook

# 1. 拉取官方最新代码
git checkout main
git pull upstream main

# 2. 将自定义功能 rebase 到最新 main
git checkout custom/stable-features
git rebase main

# 3. 冲突时优先保留本分支的自定义修改
#    （见下方冲突解决原则）

# 4. 构建并重启
npm run build
pm2 restart wrong-notebook

# 5. 推送自定义分支到你的 Fork（备用）
git push origin custom/stable-features
```

## 冲突解决原则

rebase 冲突时，优先保留 `custom/stable-features` 的以下文件：
- `src/components/knowledge-filter.tsx` — 筛选按钮修复
- `src/app/print-preview/page.tsx` — 随机排列 + 图片缩放
- `src/lib/translations.ts` — shuffle 翻译键
- `src/lib/image-utils.ts` — 图片压缩参数
- `src/app/globals.css` — 打印样式中的图片限制
