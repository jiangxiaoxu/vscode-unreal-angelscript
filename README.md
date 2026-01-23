## Language Model Tool
This branch specifically implements the runtime required to expose Language Model Tool calls for Copilot’s use.
本分支实现的目标是让相关工具调用可以被 GitHub Copilot 使用。

- Exposes the angelscript_searchApi tool call so Copilot can query the API.
- 提供了 angelscript_searchApi 工具调用以便 Copilot 查询 API。
- Exposes the angelscript_resolveSymbolAtPosition tool call so Copilot can resolve symbols at a document position.
- 提供了 angelscript_resolveSymbolAtPosition 工具调用以便 Copilot 解析光标位置的符号。
- Exposes the angelscript_getTypeMembers tool call so Copilot can list members of a type.
- 提供了 angelscript_getTypeMembers 工具调用以便 Copilot 查询类型成员列表。

### angelscript_resolveSymbolAtPosition
输入：`uri`（文档 URI）、`position`（`line`/`character`，0-based）、`includeDocumentation`（可选，默认 true）。
输出为 JSON 字符串：
- 成功：`{ ok:true, symbol:{ kind, name, signature, definition?, doc? } }`
- 失败：`{ ok:false, error:{ code, message, retryable?, hint? } }`（工具层错误可能返回 `INTERNAL_ERROR`）
常见错误 code：`NotFound`、`NotReady`、`InvalidParams`、`Unavailable`、`INTERNAL_ERROR`。

示例（LM tool）：
```json
{
  "uri": "file:///C:/Project/Script/MyActor.as",
  "position": { "line": 42, "character": 7 },
  "includeDocumentation": true
}
```

示例输出：
```json
{
  "ok": true,
  "symbol": {
    "kind": "class",
    "name": "UObject",
    "signature": "class UObject",
    "definition": {
      "uri": "file:///C:/Project/Script/UObject.as",
      "startLine": 12,
      "endLine": 120
    },
    "doc": {
      "format": "markdown",
      "text": "Base object type."
    }
  }
}
```

### angelscript_getTypeMembers
输入：`name`（必填）、`namespace`（可选，根命名空间用空字符串）、`includeInherited`（默认 false）、`includeDocs`（默认 false）、`kinds`（`both`/`method`/`property`）。
输出为 JSON 字符串：
- 成功：`{ ok:true, type:{ name, namespace, qualifiedName }, members:[{ kind, name, signature, description, declaredIn, declaredInKind, isInherited, isMixin, isAccessor, accessorKind?, propertyName?, visibility }] }`
- 失败：`{ ok:false, error:{ code, message } }`（工具层错误可能返回 `UE_UNAVAILABLE`/`INTERNAL_ERROR`）
常见错误 code：`NotFound`、`InvalidParams`、`UE_UNAVAILABLE`、`INTERNAL_ERROR`。

成员字段包含：`kind`、`name`、`signature`、`description`、`declaredIn`、`declaredInKind`、`isInherited`、`isMixin`、`isAccessor`、`accessorKind?`、`propertyName?`、`visibility`。

示例（LM tool）：
```json
{
  "name": "UObject",
  "namespace": "",
  "includeInherited": true,
  "includeDocs": false,
  "kinds": "both"
}
```

示例输出：
```json
{
  "ok": true,
  "type": {
    "name": "UObject",
    "namespace": "",
    "qualifiedName": "UObject"
  },
  "members": [
    {
      "kind": "method",
      "name": "GetName",
      "signature": "string GetName() const",
      "description": "",
      "declaredIn": "UObject",
      "declaredInKind": "type",
      "isInherited": false,
      "isMixin": false,
      "isAccessor": false,
      "visibility": "public"
    }
  ]
}
```

## MCP (HTTP) 支持 / MCP (HTTP) support
为了让 Codex 通过 MCP 调用同样的 `angelscript_searchApi` 能力，本仓库增加了一个内置的
Streamable HTTP MCP server，会复用 Angelscript language server 的 API 搜索逻辑。
对外暴露工具名：`angelscript_searchApi`（输入/输出与现有 schema 一致，输出为 JSON 字符串；`searchIndex` 必填，`maxBatchResults` 默认 200，`includeDocs` 默认 false；签名字段为 `signature`，文档字段为 `docs`，并返回 `nextSearchIndex`/`remainingCount` 用于分页）。
查询规则：空格表示“有序通配”（`a b` 可匹配 `a...b`），`|` 表示 OR 分隔；`.`/`::` 无空格时要求紧邻（如 `UObject.`、`Math::`），带空格时为模糊分隔（如 `UObject .`、`Math ::`）。
可选参数：`includeDocs` 用于控制是否返回 `docs`，`maxBatchResults` 用于控制单次返回数量，`kinds` 用于筛选结果类型（`class`/`struct`/`enum`/`method`/`function`/`property`/`globalVariable`，大小写不敏感，支持多选），`source` 用于筛选来源（`native`/`script`/`both`，默认 `both`），`labelQueryUseRegex` 启用 label 正则（对 `labelQuery` 生效，先做 kinds 过滤再做正则，仅匹配 label；支持 `/pattern/flags`，省略 `i` 表示区分大小写；不使用 `/pattern/flags` 时默认忽略大小写），`signatureRegex` 启用 signature 正则（对解析后的 signature 生效，支持 `/pattern/flags`，省略 `i` 表示区分大小写；不使用 `/pattern/flags` 时默认忽略大小写；与 `labelQueryUseRegex` 同时启用时先 label 再 signature 过滤）。
错误返回为结构化 JSON：`{ ok:false, error:{ code, message, details? } }`，常见 code 包含：`MISSING_LABEL_QUERY`、`DETAILS_UNAVAILABLE`、`INVALID_REGEX`、`INVALID_SEARCH_INDEX`、`INVALID_MAX_BATCH_RESULTS`、`INVALID_SOURCE`、`UE_UNAVAILABLE`、`INTERNAL_ERROR`、`RESOURCE_ERROR`。
空结果返回为结构化 JSON（`items` 为空数组，`total=0`，`nextSearchIndex=null`），并包含：
- `text`: `No Angelscript API results for "<labelQuery>".`
- `request`: 回显关键输入（`labelQuery`、`searchIndex`、`maxBatchResults`、`kinds`、`source`、`labelQueryUseRegex`、`signatureRegex`，其中 `signatureRegex` 为空时不返回）。

示例（LM tool）：
```json
{
  "labelQuery": "UObject",
  "searchIndex": 0,
  "source": "native",
  "kinds": ["class", "method"],
  "includeDocs": false
}
```

示例（MCP resource）：
```
mcp://angelscript-api-mcp/search?labelQuery=UObject&searchIndex=0&source=script&kinds=class
```

UI 说明：
- Search 面板顶部提供 Native / Script / Both 选项卡用于切换搜索来源。
- 选择会保存在 webview state 中，重启 VS Code 后会恢复上一次选择。

默认行为：
- 扩展启动后每 1 秒检查 `localhost:<端口>/health` 是否存在 MCP 服务（校验 `serverId`，超时 300–500ms）。
- 若没有 MCP 服务，则尝试绑定端口并启动 MCP 服务。
- 若端口被占用或已有 MCP 服务，扩展会静默等待并重试。
- 若端口被其它服务占用（`/health` 无法连通且绑定失败多次），扩展会提示错误并停止重试。

1. 编译插件：
   ```bash
   npm run compile
   ```
2. 在 VS Code 配置中启用并设置端口（可选，默认启用）：
   ```json
   {
     "UnrealAngelscript.mcp.enabled": true,
     "UnrealAngelscript.mcp.port": 0,
     "UnrealAngelscript.mcp.maxStartupFailures": 5
   }
   ```
   说明：`mcp.port = 0` 表示使用 `UnrealAngelscript.unrealConnectionPort + 100` 作为端口。
3. 在 Codex 配置中添加 MCP server（HTTP）：
   ```toml
   [mcp_servers.angelscript]
   url = "http://127.0.0.1:27199/mcp"
   ```

说明：
- MCP server 会连接 Unreal Editor（默认端口 27099）来加载类型信息，确保 Unreal Editor 已运行。
- 多个 VS Code 实例会共享同一端口，只有一个实例会启动 MCP 服务。

Language Server and Debug Adapter for use with the UnrealEngine-Angelscript plugin from https://angelscript.hazelight.se

## Getting Started
After building or downloading the Unreal Editor version with Angelscript
enabled from the github page linked above, start the editor and use visual
studio code to open the 'Script' folder created in your project directory.
Your 'Script' folder must be set as the root/opened folder for the extension to
function.

## Features
### Editor Connection
The unreal-angelscript extension automatically makes a connection to the
running Unreal Editor instance for most of its functionality. If the editor
is not running, certain features will not be available.

### Code Completion
The extension will try to complete your angelscript code as you type it
using normal visual studio code language server features.

### Error Display
When saving a file the unreal editor automatically compiles and reloads it,
sending any errors to the visual code extension. Errors will be highlighted
in the code display and in the problems window.

### Debugging
You can start debugging from the Debug sidebar or by pressing F5. While
debug mode is active, breakpoints can be set in angelscript files and
the unreal editor will automatically break and stop execution when
they are reached.

Hitting 'Stop' on the debug toolbar will not close the unreal editor,
it merely stops the debug connection, causing breakpoints to be ignored.

When the debug connection is active, any exceptions that occur during
angelscript execution will automatically cause the editor and visual
studio code to pause execution and show the exception.

### Go to Symbol
The default visual studio code 'Go to Definition' (F12) is implemented for
angelscript symbols. A separate command is added to the right click menu
(default shortcut: Alt+G), named 'Go to Symbol'. This command functions
identically to 'Go to Definition' for angelscript symbols.

If you have the Unreal Editor open as well as Visual Studio proper showing
the C++ source code for unreal, the extension will try to use its
unreal editor connection to browse your Visual Studio to the right place,
similar to double clicking a C++ class or function in blueprints.

This uses the standard unreal source navigation system, which is only
implemented for classes and functions.

### Region Blocks
The editor context menu includes a "Wrap with //#region" command for angelscript.
If there is no selection, it inserts a region template and places the cursor on the label.
Selections are expanded to full lines before wrapping.

### Add Import To
The 'Add Import To' (default shortcut: Shift+Alt+I) command from the
right click menu will try to automatically add an import statement
to the top of the file to import the type that the command was run on.

### Quick Open Import
The 'Quick Open Import' (default shortcut: Ctrl+E or Ctrl+P) command from the
right click menu will try to open the quick open navigation with the import
statement.

### More Language Features
This extension acts as a full language server for angelscript code. This includes
semantic highlighting, signature help, reference search, rename symbol and a number
of helpful code actions and quickfixes.

Some of these features require an active connection to the unreal editor.

### Semantic Symbol Colors
There are more types of semantic symbols generated by the extension than there
are colors specified by most color themes.

The default visual studio code color theme will display all variables in blue,
for example, regardless of whether the variable is a member, parameter or local.

You can add a snippet to your `.vscode/settings.json` inside your project folder
to add extra colors to make these differences more visible.

For example, to add extra colors to the default vscode dark theme:

```
    "editor.tokenColorCustomizations": {
		"[Default Dark+]": {
			"textMateRules": [
				{
					"scope": "support.type.component.angelscript",
					"settings": {
						"foreground": "#4ec962"
					}
				},
				{
					"scope": "support.type.actor.angelscript",
					"settings": {
						"foreground": "#2eb0c9"
					}
				},
				{
					"scope": "variable.parameter.angelscript",
					"settings": {
						"foreground": "#ffe5d9"
					}
				},
				{
					"scope": "variable.other.local.angelscript",
					"settings": {
						"foreground": "#e8ffed"
					}
				},
				{
					"scope": "variable.other.global.angelscript",
					"settings": {
						"foreground": "#b99cfe"
					}
				},
				{
					"scope": "variable.other.global.accessor.angelscript",
					"settings": {
						"foreground": "#b99cfe"
					}
				},
				{
					"scope": "entity.name.function.angelscript",
					"settings": {
						"foreground": "#b99cfe"
					}
				},
				{
					"scope": "invalid.unimported.angelscript",
					"settings": {
						"foreground": "#ff9000"
					}
				},
			]
		}
	}
```
