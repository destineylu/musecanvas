# 创作工作台 Implementation Plan

**Goal:** 在 musecanvas v1.0 提供素材库、生成历史与画布回退、AI 搭建、分镜表和自动布局。
**Architecture:** 保留现有 SQLite、画布 JSON 和生成队列；新增工作台 API、版本表与素材标签。AI 仅返回经过校验的方案，应用时追加节点并建立连线，不自动提交生成。历史回退先备份当前文档。
**Tech Stack:** Node/Express/SQLite、React、现有 Muse 双上游。

## Task 1: 数据与历史
- 新建 server/src/workbench.js：版本记录、素材列表和权限检查。
- 更新 server/src/routes/projects.js：自动记录旧画布，保存分镜数据。
- 新建 server/src/routes/workbench.js：素材、画布版本、生成记录、AI 方案接口。
- 验证独立账号隔离、历史恢复前备份、素材保留。

## Task 2: 布局与分镜模型
- 新建 shared/canvas-workflow.js：校验分镜与 AI 节点/边，确定性自动布局。
- 测试无边、分支、循环、不同尺寸节点，保持节点内容和连线。

## Task 3: 素材库与历史面板
- 新建 web/src/components/CanvasWorkbench.jsx 和样式。
- 素材搜索、类型筛选、收藏标签、预览和插入；生成任务记录、重用历史结果、画布版本预览和回退。
- 新增独立素材库页面和侧栏入口，支持上传。

## Task 4: AI 搭建、分镜表和自动整理
- 在 Canvas.jsx 接入工作台、记录检查点、应用方案和插入素材。
- AI 描述生成预览，确认应用后创建节点和连线；分镜行编辑、CSV 导入导出、生成图片/视频节点组。
- 自动整理前保留版本，完成后适配视口。

## Task 5: 验证与更新
- 测试纯布局算法、真实 HTTP 权限/版本/素材、模拟 Muse 方案校验、浏览器编辑保存重载和回退。
- 前端构建；确认无运行任务后更新服务；本机既有数据只做读取验证。
