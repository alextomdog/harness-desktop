# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

> **本仓库是 DeepSeek Harness 的修改版分支（fork）。** 它不由 DeepSeek AI 发布、背书或关联。
> 上游项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
> 原始版权声明保留在 [LICENSE](LICENSE) 中；本仓库的改动见下文与提交历史。下文中的上游文档、
> Discussions、社群二维码等链接均指向前述上游项目。

## 这个版本做了什么

本分支保留上游「一切皆插件」的 agent harness，并把它包装成**桌面应用**，工作重心放在「人坐在 agent 旁边时真正会用到的部分」。

**桌面应用**

- Windows 上的 Electron 打包应用（`pnpm run package:desktop:win:x64:unsigned` 产出 NSIS 安装包，同时产出一份免安装目录版）。
  应用自带运行时，接收方装上即可运行，不需要另装 Node.js。
- 同一套界面也可作为 Web UI 使用（`pnpm dsh web`），这仍是体验 harness 最快的方式。

**工作区、会话与文件**

- 工作区各自持有会话列表。工作区那一行**支持鼠标右键**，弹出与「…」相同的菜单：重命名、复制工作区路径、
  **在文件资源管理器中打开该工作区目录**、删除。
- 每个工作区有自己的文件树，支持常规文件操作（打开、重命名、新建、删除、复制相对/绝对路径），
  并且可以把文件树里的真实文件**拖拽到其它应用**里。

**右侧栏**

对话旁边的那一列放的是「工作所围绕的材料」，按材料类型分页签：文件、文档预览、网页、计划、变更审查、定时任务、终端。
切到别处工作时页签保持挂载，切回来**不会重新加载**你正在看的内容。

**就地编辑文件**

- 在预览里打开的文档**可以直接编辑**：点「编辑」即把阅读器变成编辑器，`Ctrl + S`（macOS 为 `Cmd + S`）写回文件，
  页签会出现编辑器标志性的「未保存」圆点。关闭有未保存改动的页签会先询问，并提供「保存并关闭」，而不是把工作丢掉。
- 保存会带上「读取时的版本」，所以文件在你编辑期间被别人改过时，这是一个**选择**（保留我的改动 / 改用文件现有内容），
  而不会静默覆盖。
- 表格在网格中直接编辑、同样方式保存，每次保存是增量补丁而不是整体重写；若工作簿含有写入器会丢失的特性，则保持只读，
  以免保存时丢内容。
- 编辑器带查找 / 替换（`查找 / 替换`），作用于它保存的同一份缓冲区。
- **`Shift + Space` 把选区引用进输入框。** 在文档里选一段、或在网页里选中文字，按这组键即以引用形式进入对话；
  编辑器自身的选区同样可用，不限于网页。

**内置浏览器（「网页」视图）**

- 应用内置一个浏览器，agent 可以用与其它地方一致的工具体系驱动它：列出已打开页面、选择页面、导航、在页面里执行脚本、
  截图、读取控制台与网络流量。页面按位置寻址，并且「读者正在看的页面」与「仅仅存在的页面」是两回事。
- 面对会询问的站点，页面以**普通 Chrome**的身份作答，而不是暴露应用自身的引擎 —— 因为相当多的站点会拒绝其它身份。
- `Ctrl + 滚轮`缩放页面，缩放会自报并提供复位入口；在「对话」与「网页」之间来回切换时页签不会丢失；
  重载或重启之后，视图会回到上次停留的那个页面。
- 浏览器页面由**应用自身**（而非站点）创建与销毁，宿主会记录原因（主动释放、被销毁、渲染进程崩溃），
  使「页面丢了」可以被诊断，而不只是被看见。

**工具与技能**

- agent 侧工具覆盖文件、shell（bash 与 PowerShell）、网页以及内置浏览器。
- 文档作为一等材料：通过内置 Word 工具读取、生成、渲染、拆分与合并 Word 文档；通过内置 LibreOffice 运行时做 Office 转换。
- 插件体系，所以上面这些能力可以在不 fork 的前提下新增、替换或移除。

**状态**

开发者预览：接口与行为仍在变化，预计会出现破坏兼容性的变更。

<a id="dev-preview"></a>


## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从**本仓库**源码运行（`Node.js >= 22.19`、`pnpm 11.7`）：

```sh
git clone https://github.com/alextomdog/harness-desktop.git
cd harness-desktop
corepack pnpm install --no-frozen-lockfile
corepack pnpm run build:lib
corepack pnpm run build:web
```

`--no-frozen-lockfile` 在这里是必要的：某个 workspace 包新增过依赖，而本分支的 lockfile 正是由这次安装同步到位的。
冻结安装会拒绝这种不一致，导致某个 workspace 依赖没有被链接上，随后在打包阶段以「无法解析 `workspace:` 说明符」失败。

用已构建产物运行 **Web UI**：

```sh
corepack pnpm dsh web
```

从源码运行**桌面应用**（会重建它需要的产物并启动应用）：

```sh
cd apps/desktop
corepack pnpm run dev
```

构建 Windows 安装包：

```sh
cp .env.windows.example .env.windows   # 填入本地发布设置
corepack pnpm run package:desktop:win:x64:unsigned
```

打包流水线要求上面这份发布设置（其中包括更新/策略源）；本地未签名构建可以填占位的 `https://` 源，
代价是自动更新不可用。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群！扫描下方二维码填写入群问卷，小助手会定期发送入群邀请。

<table>
  <thead>
    <tr>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
