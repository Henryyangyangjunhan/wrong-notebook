# 自定义功能更新说明

所有自定义功能位于 `custom/stable-features` 分支。

## 包含的自定义功能

1. **筛选按钮修复** — 知识点和章节下拉在有数据时始终可点击，不再因选择"全部"而变灰
2. **图片尺寸保留** — 打印预览图片缩放滑块 (30%-100%)、详情页全宽图片查看器、压缩逻辑等
3. **随机排列打印** — 打印预览页新增「随机排列」复选框，使用 Fisher-Yates 算法打乱题目顺序，同时保留每道题的原题号不变

## 拉取官方更新后合并

```bash
# 拉取最新官方代码
git fetch origin
git checkout main
git pull origin main

# 将自定义功能 rebase 到最新的 main 上
git checkout custom/stable-features
git rebase main

# 冲突时优先保留本分支的图片尺寸和随机排列修改
```

## 冲突解决原则

如 rebase 时发生冲突，优先保留 `custom/stable-features` 分支的以下文件改动：
- `src/components/knowledge-filter.tsx` — 筛选按钮修复
- `src/app/print-preview/page.tsx` — 随机排列 + 图片缩放
- `src/lib/translations.ts` — shuffle 翻译键
- `src/lib/image-utils.ts` — 图片压缩参数
- `src/app/globals.css` — 打印样式中的图片限制
