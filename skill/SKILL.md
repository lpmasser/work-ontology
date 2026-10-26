---
name: infohub
description: "查询 InfoHub 本体：开工时取项目开工说明（适用规范、工作方法及何时使用、进行中的工作、需关注），按类型/项目/属性/文本查找对象，沿关系 Search Around，校验改过的文档。需要查 InfoHub 时用它，代替 grep。"
---

# InfoHub 命令行

三个平台统一执行 `infohub <命令>`。接入时运行 `node work-ontology/scripts/install.mjs`：自动克隆或复用 InfoHub、安装全局命令、清理旧托管，并在没有工作台时从公开更新站点验签后首次安装；已有工作台不重装，后续升级由 Tauri updater 自动处理；可用 `--root <InfoHub目录>` 指定已有副本。Skill 只提供说明。InfoHub 位置由安装时写入的用户主目录下 `.config/infohub/config.json` 决定，也可用 `--root <目录>` 临时指定。Windows 使用 USERPROFILE，macOS/Linux 使用 HOME。

| 命令 | 用途 |
| --- | --- |
| `brief <项目ID或名称>` | 开工说明。接手项目任务时先运行，按其中的工作方法和规范办事 |
| `find [文本] [--type 类] [--project 项目] [--where 字段=值]...` | 查找对象，条件取交集 |
| `around <ID或路径>... [--relation 关系] [--direction outgoing\|incoming]` | 沿关系找相邻对象 |
| `get <ID或路径>` | 对象路径与全部属性；正文直接读文件 |
| `sync status` | 后台运行情况、最近拉取/草稿/推送、跳过原因和服务器草稿待处理项（JSON） |
| `sync run [--fetch-seconds N] [--draft-seconds N] [--idle-seconds N]` | 在前台运行唯一同步循环；桌面由 InfoHub Workbench 托管，服务器由 Docker 托管。首次已有未提交内容须确认后加 `--include-existing` |
| `sync logs` | 查看日志入口；退出工作台或停止容器即可停止同步 |
| `check [路径...]` | 校验；改完文档后对改过的文件运行，有问题退出码 1 |

不知道项目 ID 时运行 `brief` 加任意名称，报错会列出全部项目。
