# WyerpTaskboard｜本地多项目任务看板

独立的本机任务治理服务，提供任务看板、用户审阅、开发/独立测试流转、资源记录和可选自动化协作。项目根为 `D:\WyerpTaskboard`，默认地址为 `http://127.0.0.1:47831`。

ERP等项目只是被管理数据源，不是看板的启动、登录或运行依赖。每个项目自己的任务注册表是任务状态真值；看板不保存第二套业务正文。

## 环境与配置

- Node.js要求以 `package.json.engines` 为准，当前为 **≥24**；Windows专属脚本、桌面控制台与Windows-MCP需要对应的Windows环境。
- 项目列表读取 `config/projects.json`，不在README中写死“只管理自身”。项目是否登记、源是否健康、是否允许写入分别核验。
- AI执行参数读取 `config/ai-execution.json`。Chat Wake与健康监控分别读取 `config/chat-browser-wake.json`、`config/chatgpt-health.json`；扩展已配置启用不等于浏览器实际加载、候选已投递或自动化已通过验收。
- 源码、正式服务和扩展实际版本分别记录，见[当前状态](docs/当前项目状态.md)。配置文件、密钥、事件和运行数据不得随意删除或公开。

## 先只读查看

在项目根目录的PowerShell中执行：

```powershell
Set-Location 'D:\WyerpTaskboard'
node --version
node cli/service.mjs status
node cli/taskctl.mjs help
node cli/taskctl.mjs projects
node cli/taskctl.mjs list --project wyerp-taskboard
```

`projects/list/get`要求服务可访问且本机认证配置有效；`help`只显示用法，不创建或认领任务。不要把服务不可访问当成项目目录为空。

## 服务控制：会产生副作用

只在已授权启动/关闭当前看板时执行，不把这些命令当成文档检查步骤：

```powershell
node cli/service.mjs start
node cli/service.mjs stop
```

启动入口可能请求启动全局控制台，常驻服务也可能按现有配置运行扫描；启动前先核对自动化开关与运行范围。启动看板不等于授权无人值守或操作GPT。启停不得影响ERP等被管理项目，也不得终止身份未知的端口占用者。

浏览器打开本机地址后按页面建立独立认证。管理员密钥只在自己的本机终端读取和使用，不粘贴到聊天、报告或共享截图。

## AI执行顺序

先读[AGENTS](AGENTS.md)与[文档索引](docs/文档索引.md)，确认实际任务、角色、版本和资源。正式任务必须通过结构化 `create` 接口登记，不手工拼接Markdown机器表。

以下为**已存在、已授权任务**的认领模板；必须替换全部占位值，不能直接对示例或他人任务执行：

```powershell
$Project = 'wyerp-taskboard'
$Task = '替换为真实任务ID'
$Actor = '替换为唯一执行者ID'
$Session = '替换为当前真实Session'
node cli/taskctl.mjs get --project $Project --task $Task
node cli/taskctl.mjs guard --project $Project --task $Task --actor-type developer_ai --actor-id $Actor --session-id $Session
# 先在当前聊天真实汇报任务、边界、版本、资源；再登记汇报事件。
node cli/taskctl.mjs preclaim-report --project $Project --task $Task --actor-type developer_ai --actor-id $Actor --session-id $Session --note '填写本次已汇报的真实范围'
node cli/taskctl.mjs guard --project $Project --task $Task --actor-type developer_ai --actor-id $Actor --session-id $Session
# 确认无停止、未读留言、依赖或实时占用阻断后，才可继续：
node cli/taskctl.mjs claim --project $Project --task $Task --actor-type developer_ai --actor-id $Actor --assignee $Actor --session-name '填写可识别窗口名' --session-id $Session
```

测试角色必须使用独立身份和 `--actor-type test_ai`，并先核对固定版本、自测证据及代码修改历史。只有claim成功后才能在授权范围内修改/测试；实际修改后记录 `changed`，测试前后记录 `test-start/test-result`，交接时原子同步阶段、角色和释放结果。详细流程只维护于[中央协作规范](docs/governance/AI协作与任务流转规范.md)。

所有项目型写命令必须显式指定 `--project`。同一个结果未知的操作重试时复用稳定 `--operation-id`，先查结果再重试；重复启动CLI且不传该参数会生成新操作ID，不等于安全重试。

## 检查与验收

```powershell
npm run check
```

这是语法检查，不证明页面或运行闭环通过。`npm test`包含更广的业务与自动化专项，只有测试范围、资源和授权确认后才执行；文档变更不机械触发全量运行。测试层级与证据要求见[核心测试需求](docs/项目级核心功能测试需求.md)。

## 快捷方式与维护

快捷方式安装/移除脚本为 `scripts/install-shortcuts.ps1`、`scripts/remove-shortcuts.ps1`，仅在明确需要时执行。现有快捷方式可能仍使用“网研ERP任务看板”名称，这是历史显示名，不代表依赖ERP。

故障先查 `data/runtime/system-events/`，再按任务/trace下钻专项日志。Git流程见[Git规则](docs/governance/Git与工作空间协作规则.md)，自动化权限见[全局哨兵计划](docs/plans/全局状态哨兵与人工接管开发计划.md)。stop/guard仍是协作协议，不能宣传成覆盖任意Shell/Runner通道的物理硬锁。
