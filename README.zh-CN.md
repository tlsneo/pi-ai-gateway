# pi-ai-gateway

> **[English](README.md)**

把任意 OpenAI 兼容网关（newapi、one-api、自建代理等）注册为 [Pi](https://pi.dev) 的 provider。

- **自动发现模型**：启动时 fetch `{baseUrl}/v1/models`，网关里新增模型自动出现
- **自动协议路由**：新建网关默认让 Pi 官方 OpenAI 模型走 `/v1/responses`，其他模型走 `/v1/chat/completions`
- **自动借元数据**：从 Pi 内置模型目录（`pi update --models` 刷新的那份）借用思考强度 / 思考档位 / 上下文 / compat
- **网关实际价格优先**：网关支持时自动读取 `{网关根地址}/api/pricing`，包括按上下文长度分档的价格
- **可选价格预设**：网关缺少某模型价格时，可按网关显式选择 Models.dev 或 BaseLLM；手动价格始终最高优先级
- **零噪音**：自动剔除 image / embedding / tts 等不可聊天的模型
- **弹性**：单网关失败不影响 Pi 启动，断网时用上次缓存降级
- **零依赖**：纯扩展，无第三方 npm 依赖

## 安装

```bash
pi install git:github.com/tlsneo/pi-ai-gateway
```

本地开发也可以用路径安装（改代码后重启 Pi 即生效）：

```bash
pi install ./pi-ai-gateway
```

## 配置

创建 `~/.pi/agent/ai-gateway.json`（模板见 `ai-gateway.example.json`）：

```json
{
  "gateways": [
    {
      "name": "newapi",
      "baseUrl": "https://your-gateway.example.com/v1",
      "apiKey": "sk-你的密钥",
      "apiRouting": "auto",
      "pricePreset": "models-dev"
    }
  ]
}
```

`apiRouting: "auto"` 是 `/ai-gateway add` 创建新网关时的默认值：Pi 官方 `openai.json` 中声明为 `openai-responses` 的模型使用 `/v1/responses`，其余模型继续使用 `/v1/chat/completions`。`pricePreset` 是可选项；如果只希望使用网关自己公布的价格，可以省略。

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | provider 名，模型显示为 `newapi/gpt-5.6-sol`；不能与 Pi 内置 provider 重名 |
| `baseUrl` | ✅ | 网关地址；缺 `/v1` 会自动补 |
| `apiKey` | ✅ | 直接写密钥（也支持 `$ENV` 引用语法） |
| `api` | ❌ | 强制整个网关使用一种 Pi API 类型；设置后优先于 `apiRouting` |
| `apiRouting` | ❌ | `"auto"`：OpenAI 官方 Responses 模型走 `openai-responses`，其他模型走 `openai-completions`；通过 `/ai-gateway add` 新建时默认写入 |
| `headers` | ❌ | 附加请求头 |
| `pricePreset` | ❌ | 缺失价格回退：`"models-dev"` 或 `"basellm"`；省略时只采用网关价格 |
| `overrides` | ❌ | 按模型覆盖元数据及手动价格（见下） |

协议选择优先级：

```text
显式 api > apiRouting: "auto" > openai-completions
```

自动识别依据是 Pi 自带的 `openai.json`，不是 `gpt-` 前缀，因此 `gpt-oss-*` 和未登记的网关别名默认仍走 Chat Completions。普通 API Key 网关使用的是 `openai-responses`，不是 `openai-codex-responses`。网关如果不支持 `/v1/responses`，可显式设置 `"api": "openai-completions"`。

配置完成后重启 Pi，`/model` 里即可看到对应 provider 前缀的全部模型。

> 密钥安全：配置文件在仓库外，权限自动设为 600。仓库里只有 `ai-gateway.example.json`（占位符，零密钥），请勿提交真实配置文件。

### overrides：按模型覆盖元数据（可选）

默认情况下，能力信息来自 Pi 内置目录；价格则优先来自网关自身的 `/api/pricing`。个别模型仍可手动调整：

```json
{
  "gateways": [
    {
      "name": "newapi",
      "baseUrl": "https://your-gateway.example.com/v1",
      "apiKey": "sk-xxx",
      "overrides": {
        "gpt-5.6-sol": { "contextWindow": 272000 },
        "gpt-5.6-terra": { "contextWindow": 272000, "maxTokens": 64000 },
        "hy3-preview": { "reasoning": true }
      }
    }
  ]
}
```

支持覆盖的字段：`contextWindow` / `maxTokens` / `reasoning` / `thinkingLevelMap` / `cost` / `compat` / `name`。手动 `cost` 覆盖拥有最高优先级。只覆盖列出的模型，其余模型照常自动。设置 `contextWindow` 后 Pi 会在接近上限时自动压缩，请求不会超限。

### 价格优先级与预设

每个网关模型独立按以下顺序决定价格：

```text
手动模型价格 > 网关 /api/pricing > 已选择的回退预设 > $0
```

默认不会自动套用公共预设，避免把“官方参考价”误显示成某个代理网关的实际收费。

```text
/ai-gateway set-price show
/ai-gateway set-price preset models-dev
/ai-gateway set-price preset basellm
/ai-gateway set-price preset none
```

- `models-dev`：网关没有价格时，从 <https://models.dev/api.json> 读取按服务商区分的参考价格。
- `basellm`：将 <https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json> 的 NewAPI 倍率预设换算成每百万 token 美元价格。
- `none`：恢复默认，只采用网关价格；缺少价格时为 `$0`。

手动设置单模型价格，单位为每百万 token 美元：

```text
/ai-gateway set-price manual gpt-5.6-sol 5 30 0.5 6.25
/ai-gateway set-price remove gpt-5.6-sol
```

`manual` 后不带参数时会交互询问模型和四项价格。手动价格保存在现有的 `overrides.cost` 字段中。

## 命令

```
/ai-gateway add          交互向导添加网关（name → baseUrl → apiKey）
/ai-gateway list         列出已配置网关
/ai-gateway remove <name> 移除网关
/ai-gateway test <name>   测试连通性 + 报告模型数
/ai-gateway overrides     查看当前网关的模型覆盖
/ai-gateway overrides add [模型ID] [contextWindow] [maxTokens]
                          交互设置单模型覆盖（自动带出当前档案值作默认）
/ai-gateway overrides remove <模型ID>
                          移除某个模型的覆盖
/ai-gateway set-price show
                          查看该网关的价格回退预设和手动价格
/ai-gateway set-price preset <none|models-dev|basellm>
                          为该网关选择缺失价格回退
/ai-gateway set-price manual <模型ID> <输入> <输出> [缓存读取] [缓存写入]
                          设置每百万 token 美元价格
/ai-gateway set-price remove <模型ID>
                          删除手动模型价格
```

### 交互设置模型覆盖（不用手改 JSON）

```
/ai-gateway overrides add
  → 输入模型 ID（如 gpt-5.6-sol）
  → 上下文窗口？回车保留当前档案值，输入 272000 则改为 27.2 万
  → 最大输出？回车保留
  → 思考支持？保留 / true / false
  → 保存并自动重新注册，立即生效
```

也可以一次性给参数（跳过提问）：

```
/ai-gateway overrides add gpt-5.6-sol 272000
/ai-gateway overrides add gpt-5.6-sol 272000 64000
```

## 工作原理

```
启动时，对每个网关：
  1. GET {baseUrl}/v1/models            → 模型名单
  2. GET {网关根地址}/api/pricing       → 网关价格（尽力获取）
  3. 索引 Pi 内置目录 providers/data/*.json → 能力档案库
  4. 从 Pi 官方 openai.json 建立 Responses 模型集合
  5. 每个模型 id 借能力元数据：
     reasoning / thinkingLevelMap / contextWindow / maxTokens / compat
     找不到 → 安全默认值（无思考、128K）
  6. 解析价格：手动 > 网关 > 已选预设 > $0
  7. 合并其他用户覆盖
  8. 选择协议：官方 OpenAI Responses 模型 → /v1/responses；其他模型 → /v1/chat/completions
  9. 自动过滤 image/embedding/audio/tts/rerank 类模型
  10. 注册为 provider：newapi/gpt-5.6-sol
```

### 配置文件 vs 缓存文件

| | `~/.pi/agent/ai-gateway.json` | `~/.pi/agent/ai-gateway-cache.json` |
|---|---|---|
| 内容 | 网关地址、密钥、覆盖设置 | 上次拉到的模型名单快照 |
| 谁写的 | 你（或 `/ai-gateway` 命令） | 扩展每次注册时自动覆盖 |
| 生命周期 | 永久（这是配置） | 易失（随时重写/可删） |
| 用途 | 你的意志，Pi 启动时读取 | 网关不可达时降级兜底 |

覆盖设置**必须**在配置文件里——缓存每次拉模型都会被重写，放那里会被冲掉。

### contextWindow 覆盖到底影响什么

`contextWindow` 不是发给网关的请求参数，而是 **Pi 本地管理上下文的标尺**：接近上限时 Pi 自动压缩（compact），请求实际长度不会超过该值。例如给 gpt-5.6-sol 设 `272000`，请求就进不了长上下文计费档。设置后可在 `/model` 里看到数值变化。

## 开发

```bash
npm test        # node --test，纯函数单测
```

## 故障排查

| 现象 | 处理 |
|---|---|
| 启动日志 `未配置网关` | 运行 `/ai-gateway add` 或创建配置文件 |
| `与 Pi 内置 provider 重名` | 换一个 `name`（如 `my-openai`） |
| 网关注册失败但 Pi 正常启动 | 看启动日志错误；有缓存会自动降级（日志标注"缓存降级"） |
| 某模型没有思考档位 | 该模型不在内置目录，属正常（默认值）；`pi update --models` 更新目录后重启 |
