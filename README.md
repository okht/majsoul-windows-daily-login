<div align="center">

# Mahjong Soul Windows Daily Opener

### *本机随机时间被动打开雀魂，复用现有浏览器会话进入大厅*

![Platform](https://img.shields.io/badge/Platform-Windows-0078D4)
![Browser](https://img.shields.io/badge/Browser-Microsoft%20Edge-0D9488)
![Runtime](https://img.shields.io/badge/Runtime-Local%20only-16A34A)
![Input](https://img.shields.io/badge/Input-No%20synthetic%20input-EF4444)
![Notify](https://img.shields.io/badge/Email-Failure%20only-0891B2)
![License](https://img.shields.io/badge/License-Private%20use-64748B)

</div>

在你自己的 Windows 电脑上，按**本机系统时区**每天 10:00–12:30 随机打开一次雀魂网页版，复用专用 Edge 配置里的登录态，只观察是否进入大厅，然后退出。

- **成功**：静默，不发邮件  
- **失败 / 需要人工操作**：纯文字 Gmail 提醒  
- **绝不**：自动点击、填表、输入密码、截图上传、云端跑浏览器  

> [!IMPORTANT]
> 公开仓库只包含源码与文档。雀魂账号、Gmail、Edge 配置、状态与日志都在本机  
> `%LOCALAPPDATA%\MajSoulDaily` 与 Windows 凭据管理器中，**不会**也不应提交到 Git。

---

## 它做什么 / 不做什么

| 做 | 不做 |
| --- | --- |
| 定时被动打开 `https://game.maj-soul.com/1/` | 自动点击「登录」「确认」「进入游戏」 |
| 复用本机专用 Edge 会话 | 保存雀魂邮箱/密码 |
| 只读判断大厅（视觉指纹 + 可访问文本） | 保存页面截图、Cookie、Local Storage |
| 锁屏不启动；解锁且联网后可补跑 | 唤醒睡眠中的电脑 |
| 失败时发纯文字 Gmail | 成功时发邮件 |
| 本机系统时区的当地 10:00–12:30 | 强制北京时间 / 因非中国时区拒绝安装 |
| 本地运行 | 云端浏览器、代理、指纹伪装、验证码绕过 |

若页面仍需人工操作，运行器必须停止并提醒，**不会**替你点任何按钮。

---

## 工作流程

```text
Windows 任务计划（本机时区）
  ├─ 主任务：当地 10:00 + 最长 2.5h 随机延迟
  └─ 补跑：登录/解锁 + 12:30 起每 15 分钟
            ↓
检查当日状态、锁屏、网络、互斥锁
            ↓
用已安装的无窗口启动器 → 系统 Edge（CDP 观察）
            ↓
只读判断大厅
  ├─ 成功 → 记 SUCCESS，静默退出
  ├─ 需人工 → BLOCKED_MANUAL + Gmail
  └─ 瞬时故障 → 等待后续补跑
```

运行时文件（均在仓库外）：

| 路径 | 内容 |
| --- | --- |
| `%LOCALAPPDATA%\MajSoulDaily\edge-profile` | 专用 Edge 配置（登录态） |
| `%LOCALAPPDATA%\MajSoulDaily\lobby-fingerprint.json` | 大厅指纹（不可逆特征，非截图） |
| `%LOCALAPPDATA%\MajSoulDaily\state` | 按本地日期的运行状态 |
| `%LOCALAPPDATA%\MajSoulDaily\logs` | 脱敏日志（约保留 14 天） |
| `%LOCALAPPDATA%\MajSoulDaily\config.json` | 仅 Gmail 发件/收件地址 |
| Windows 凭据管理器 | Gmail 应用专用密码、指纹密钥 |
| `%LOCALAPPDATA%\MajSoulDaily\app` | 部署后的运行副本（计划任务指向此处） |

---

## 环境要求

- Windows 10/11  
- [Node.js](https://nodejs.org/) 22+  
- 已安装 Microsoft Edge  
- 能访问雀魂与 Gmail SMTP（若启用失败通知）  

---

## 快速开始

在**本仓库根目录**执行（不要在桌面等空目录跑 `npm`）。

### 1. 安装依赖并自检

```powershell
npm ci
# 若 npm ci 因文件锁失败，可用：npm install

npm run verify
```

`verify` = 单元/集成测试 + 零输入静态检查 + 仓库隐私扫描。

### 2. 建立登录态与大厅指纹

```powershell
# 可见 Edge：请手动登录并进入大厅，再回终端按 Enter
node src/cli/setup-session.mjs
```

程序会关闭可见窗口，再用**与每日任务相同的无头路径**登记指纹。

若登录已在专用配置里，只需刷新指纹：

```powershell
node src/cli/re-enroll-headless.mjs
```

### 3. 验证无头能否认出大厅

```powershell
node src/cli/verify-session.mjs
```

期望输出含 `SUCCESS`。可连续执行 2～3 次。  
无头打开与比对可能需要 **1～3 分钟**，属正常。

### 4. 配置失败通知（可选但推荐）

```powershell
node src/cli/configure-gmail.mjs
```

使用 Gmail **应用专用密码**（不是登录密码）。密码只进凭据管理器；仓库里不应出现真实邮箱。

### 5. 本机验收回执（注册任务前必做）

```powershell
npm run acceptance
```

通过后写入：

`%LOCALAPPDATA%\MajSoulDaily\acceptance-receipt.json`  

（仅本机，不进 Git。）

### 6. 部署并注册计划任务

```powershell
# 预览任务 XML，不注册、不部署
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Mode DryRun

# 部署到 %LOCALAPPDATA%\MajSoulDaily\app
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Mode Deploy

# 需要有效 acceptance receipt
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Mode Register
```

任务名：

- `MajSoulDaily-Primary`  
- `MajSoulDaily-Catchup`  

### 7. 会话失效时

```powershell
node src/cli/repair-session.mjs
```

---

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run verify` | 测试 + 零输入守卫 + 隐私扫描 |
| `npm run check:no-input` | 禁止调度路径合成输入 API |
| `npm run check:privacy` | 扫描跟踪文件中的路径/密钥/非 example 邮箱 |
| `npm run acceptance` | 本机验收并写回执 |
| `node src/cli/setup-session.mjs` | 可见登录 + 无头登记指纹 |
| `node src/cli/re-enroll-headless.mjs` | 仅无头重登记指纹 |
| `node src/cli/verify-session.mjs` | 无头大厅验证 |
| `node src/cli/configure-gmail.mjs` | 配置失败邮件 |
| `node src/cli/repair-session.mjs` | 可见修复登录态 |
| `scripts\install.ps1 -Mode DryRun\|Deploy\|Register\|Full` | 安装/注册 |
| `scripts\uninstall.ps1` | 卸载任务与本地数据（配置文件可选保留） |

---

## 隐私与安全

1. **不要**把真实邮箱、应用专用密码、绝对用户路径、截图、Edge profile 提交到 Git。  
2. 测试与文档仅使用 `@example.com` 等占位符。  
3. 日志会脱敏邮箱、Cookie、Authorization 等模式。  
4. 调度任务只允许参数 `primary` / `catchup`，且指向已安装目录，不绑定开发用 worktree 路径。  
5. 公开仓库的 `npm run check:privacy` 应在推送前保持通过。

本地卸载示例：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1
```

---

## 设计文档

- [设计说明](docs/superpowers/specs/2026-07-16-majsoul-windows-daily-login-design.md)  
- [实施计划](docs/superpowers/plans/2026-07-16-majsoul-windows-daily-login.md)  
- [计划修正案](docs/superpowers/plans/2026-07-16-majsoul-windows-daily-login-corrections.md)  

---

## 风险说明

自动访问可能受到雀魂 / Yostar 服务条款限制。本项目**不**实现降低可检测性、绕过验证码或任何平台对抗功能。请自行评估账号风险，并遵守适用条款与当地法律。

---

## 许可

私人/自用工具。若公开 fork，请自行移除一切个人数据与本地路径，并保留安全边界说明。
