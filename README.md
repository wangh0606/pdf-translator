# PDF 逐句翻译 · AI 阅读助手

左边看 PDF 原文，右边看逐句译文；点击或划选任意一句或一段，两边会同步高亮。
划选文字后可以让大模型回答问题、解释、润色或者给出修改意见。
大模型接口使用 **OpenAI 兼容格式**（`/v1/chat/completions`），OpenAI、DeepSeek、通义千问、Kimi、智谱、豆包、硅基流动、OpenRouter，以及本地的 Ollama / vLLM / LM Studio 都可以用。

## 启动

需要 Python 3.9 或更高版本。

- **macOS / Linux**：运行 `./start.sh`
- **Windows**：双击 `start.bat`

第一次运行会自动创建虚拟环境并安装依赖，然后打开 http://127.0.0.1:8000 。

手动启动：

```bash
pip install -r requirements.txt
python server.py            # 可选参数：--host 0.0.0.0 --port 8000
```

## 配置大模型

点击右上角「⚙ 设置」：

| 项目 | 说明 |
|---|---|
| API Base URL | 例如 `https://api.openai.com/v1`、`https://api.deepseek.com/v1`、`http://localhost:11434/v1`（Ollama） |
| API Key | 只保存在本机的 `data/config.json` 里，页面上只显示打码后的值 |
| 对话模型 | 用于问答、解释、润色、修改意见 |
| 翻译模型 | 可以单独填一个更便宜、更快的模型；留空就用对话模型 |
| 目标语言 | 默认是简体中文 |
| 额外翻译要求 / 术语表 | 例如 `LLM -> 大语言模型`、`agent 保留英文` |

也可以通过环境变量设置默认值：`OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`、`OPENAI_TRANSLATE_MODEL`。

## 使用

1. 点击「打开 PDF」或者直接把文件拖进窗口。打开后会自动逐句翻译，**先翻译你正在看的页面**。
2. **单击**任意一句（左边或右边都可以），另一边会高亮对应的句子并滚动过去。
3. **划选**一句或一段，两边对应的句子会一起高亮，同时弹出工具条：
   - 💬 提问：把选中的文字作为引用，在右侧 AI 助手里输入问题
   - 📖 解释 / ✨ 润色 / 📝 修改意见：直接让大模型处理
   - 🔄 重新翻译：可以附加要求，例如“更口语化”
   - 📋 复制
4. 右上角可以切换「仅译文 / 原文 + 译文」，也可以「导出」双语 Markdown。
5. 按 `Ctrl + 滚轮` 或用顶栏按钮缩放；中间的分隔条可以拖动；按 `Esc` 取消高亮。

所有译文都缓存在 `data/cache.sqlite3`，再次打开同一份 PDF 时会直接显示，不会重复消耗 token。

## 说明与限制

- 扫描版或纯图片的 PDF 没有文字层，需要先做 OCR（例如用 Adobe 或 `ocrmypdf`）。
- 断句是根据标点、缩写（e.g.、Fig.、et al. 等）和版面（段落间距、字号变化）自动判断的。复杂排版（表格、公式、页眉页脚）偶尔会切分得不准确，但不影响高亮对应关系。
- 支持推理模型：DeepSeek-R1 等返回的思考过程会显示在可折叠的「思考过程」里，翻译时会自动去掉 `<think>` 内容。

## 文件结构

```
server.py            后端（FastAPI）：静态页面、OpenAI 兼容接口代理、翻译缓存
static/index.html    页面
static/app.js        PDF 渲染、断句、高亮联动、翻译队列、AI 对话
static/style.css     样式
static/vendor/pdfjs  pdf.js 4.10（Apache-2.0），已内置，可离线使用
data/                运行时生成：config.json（配置）、cache.sqlite3（译文缓存）
```

## 后端接口

| 接口 | 说明 |
|---|---|
| `POST /api/translate` | `{segments:[{id,text}], context, force, instruction}` → `{translations:{id:text}}` |
| `POST /api/chat` | `{messages:[{role,content}], doc_context}` → NDJSON 流（`{"t":"delta","c":"..."}`） |
| `GET/POST /api/config` | 读取或修改配置 |
| `GET /api/models` | 获取模型列表（调用上游的 `/models`） |
| `POST /api/test` | 测试连接 |
