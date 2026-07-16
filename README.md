<div align="center">

# Mahjong Soul Windows Daily Opener

### *在本机随机时间被动打开雀魂，复用现有浏览器会话进入大厅*

![Status](https://img.shields.io/badge/Status-Design%20approved-7C3AED)
![Stage](https://img.shields.io/badge/Stage-Pre--implementation-64748B)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D4)
![Browser](https://img.shields.io/badge/Browser-Edge%20planned-0D9488)

![Schedule](https://img.shields.io/badge/Schedule-Random%20window-F59E0B)
![Runtime](https://img.shields.io/badge/Runtime-Local%20only-16A34A)
![Email](https://img.shields.io/badge/Email-Failure%20only-0891B2)
![Guardrail](https://img.shields.io/badge/Input-No%20synthetic%20input-EF4444)

</div>

> [!IMPORTANT]
> 项目处于「设计已批准、代码待实施」阶段。仓库目前没有可执行程序，也没有经过验证的安装命令。

## 项目目标

这个项目计划在用户家中的 Windows 电脑上运行：每天北京时间 10:00–12:30 随机打开一次雀魂网页，复用 Microsoft Edge 独立配置文件中的现有登录状态，等待页面自动进入大厅，然后关闭浏览器。

电脑错过随机窗口后，当天解锁 Windows 且联网时补跑。成功过程保持静默；失败或需要人工操作时，通过 Gmail 发送纯文字提醒。

## 已确认边界

| 范围 | 设计约束 |
| --- | --- |
| **浏览器输入** | 定时运行不点击、不输入、不填写表单、不合成鼠标或键盘事件 |
| **登录凭证** | 雀魂邮箱和密码只由用户在官方页面手动输入，程序不保存 |
| **运行位置** | 只在本地 Windows 电脑运行，不使用云端浏览器 |
| **锁屏行为** | 锁屏时不启动浏览器；解锁且联网后补跑 |
| **唤醒行为** | 不主动唤醒睡眠中的电脑 |
| **通知** | 仅失败或需要人工处理时发送纯文字 Gmail，成功不通知 |
| **页面数据** | 不保存页面截图、Cookie、Local Storage 或请求内容 |
| **平台控制** | 不包含验证码绕过、代理、浏览器指纹伪装或反检测功能 |

如果页面需要点击「登录」「确认」「进入游戏」或任何其他按钮，运行器必须立即停止，并提醒用户手动处理。

## 计划流程

```text
Windows 任务计划
  ├─ 10:00–12:30 随机触发
  └─ 错过后在解锁且联网时补跑
            ↓
检查当天状态和 Windows 会话
            ↓
使用独立 Edge 会话打开雀魂
            ↓
只读判断大厅状态
  ├─ 成功：记录状态并静默退出
  ├─ 需要操作：停止并发送 Gmail
  └─ 临时故障：等待当天后续补跑
```

## 隐私设计

- 浏览器配置、运行状态、日志和 Gmail 凭据保存在仓库外的 `%LOCALAPPDATA%\MajSoulDaily`。
- Gmail 应用专用密码计划存入 Windows 凭据管理器。
- `.gitignore` 排除常见的凭据、浏览器数据、状态、日志和截图目录。
- 公开仓库不应提交个人邮箱、绝对用户路径、Cookie、Token、密钥或真实浏览器配置。
- 日志计划保留 14 天，并对账号、会话和请求数据进行脱敏。

## 当前资料

- [完整设计文档](docs/superpowers/specs/2026-07-16-majsoul-windows-daily-login-design.md)

## 实施状态

- [x] 确认需求与安全边界
- [x] 完成 Windows 方案设计
- [ ] 验证静默 Edge 能否加载雀魂 Canvas/WebGL
- [ ] 编写运行器、状态存储和 Gmail 通知
- [ ] 注册并验证 Windows 计划任务
- [ ] 完成本机端到端验收

## 风险说明

自动访问可能受到雀魂或 Yostar 服务条款限制。项目不会实现降低可检测性或绕过平台控制的机制。使用者应自行评估账号风险，并遵守适用的服务条款。
