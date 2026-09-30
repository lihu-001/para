"""Controlled tool-calling Agent runner for the PARA conversation mode."""

from __future__ import annotations

import json
from typing import Any, Callable

import httpx

from .services import EXPENSE_STATUS_LABELS


class AgentError(RuntimeError):
    pass


# 四种报销状态及对应中文名称，供模型按代码筛选、按中文回复
STATUS_HINT = "、".join(f"{code}={label}" for code, label in EXPENSE_STATUS_LABELS.items())

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "query_expenses",
            "description": "查询支出，可按日期、类别、报销状态、商户和是否有发票筛选。只能读取数据。",
            "parameters": {
                "type": "object",
                "properties": {
                    "date_from": {"type": ["string", "null"], "description": "YYYY-MM-DD"},
                    "date_to": {"type": ["string", "null"], "description": "YYYY-MM-DD"},
                    "category": {"type": ["string", "null"]},
                    "merchant": {"type": ["string", "null"]},
                    "status": {"type": ["string", "null"], "description": f"报销状态代码：{STATUS_HINT}"},
                    "has_invoice": {"type": ["boolean", "null"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                },
                "required": ["date_from", "date_to", "category", "merchant", "status", "has_invoice", "limit"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_invoices",
            "description": "按开票日期和销售方查询发票，可只返回尚未关联的发票。只读。",
            "parameters": {
                "type": "object",
                "properties": {
                    "date_from": {"type": ["string", "null"]},
                    "date_to": {"type": ["string", "null"]},
                    "seller": {"type": ["string", "null"]},
                    "available_only": {"type": ["boolean", "null"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                },
                "required": ["date_from", "date_to", "seller", "available_only", "limit"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_summary",
            "description": "查询支出、发票、已关联和无发票金额汇总，只读。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "prepare_create_expense",
            "description": "准备新增支出。只生成待确认操作，不会直接写入数据库。",
            "parameters": {
                "type": "object",
                "properties": {
                    "expense_date": {"type": "string", "description": "YYYY-MM-DD"},
                    "amount_minor": {"type": "integer", "minimum": 1},
                    "merchant": {"type": "string", "minLength": 1, "maxLength": 200},
                    "category": {"type": "string", "minLength": 1, "maxLength": 100},
                },
                "required": ["expense_date", "amount_minor", "merchant", "category"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "prepare_import_expenses",
            "description": "根据用户提供的内容准备多条支出记录的批量导入。将来源内容转换为系统支出字段；不确定、缺失或无法映射的字段不要猜测，先向用户说明。只生成待确认批量操作，不会直接写入数据库。",
            "parameters": {
                "type": "object",
                "properties": {
                    "records": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 200,
                        "items": {
                            "type": "object",
                            "properties": {
                                "expense_date": {"type": ["string", "null"], "description": "来源内容中明确的日期 YYYY-MM-DD；缺失或无法确定时填 null"},
                                "amount_minor": {"type": "integer", "minimum": 1},
                                "merchant": {"type": "string", "minLength": 1, "maxLength": 200},
                                "category": {"type": "string", "minLength": 1, "maxLength": 100}
                            },
                            "required": ["expense_date", "amount_minor", "merchant", "category"],
                            "additionalProperties": False
                        }
                    }
                },
                "required": ["records"],
                "additionalProperties": False
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "prepare_allocation",
            "description": "准备将一张或多张完整发票关联到指定支出。返回预览并等待用户显式确认，不直接执行。先查询真实记录 ID。",
            "parameters": {
                "type": "object",
                "properties": {"expense_id": {"type": "string"}, "invoice_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1}},
                "required": ["expense_id", "invoice_ids"],
                "additionalProperties": False,
            },
        },
    },
]

SYSTEM_PROMPT = f"""你是 PARA 个人报销助手。你不是只能聊天的问答机器人；你必须通过提供的工具操作 PARA 系统接口。凡是用户要求查询、统计、分析、录入、导入、创建或关联数据，都必须调用对应工具，不能只描述应该怎么做，也不能声称没有工具。你只能使用工具暴露的业务接口，不能执行任意 SQL、命令或访问业务接口之外的系统资源。
金额使用整数分；给用户展示时换算为人民币元。
支出的报销状态在系统中以英文代码存储：{STATUS_HINT}。按状态筛选时传英文代码；回复用户时只使用中文状态名，不要展示英文代码。
用户提供文件、图片或文本时，先理解其内容和用户意图，再将可明确映射到系统字段的数据交给合适的工具。用户要求把附件中的多条记录存入系统时，必须调用 prepare_import_expenses；缺失但允许补录的日期填 null，不要因为日期缺失而放弃调用。多条支出记录使用 prepare_import_expenses 一次性准备批量导入，单条支出使用 prepare_create_expense。金额、商户或类别不明确时先询问用户。
查询必须使用工具，不能猜测数据库内容。任何写入操作都必须先生成待确认计划，不能声称已经执行；只有用户在界面点击确认后才会正式写入。回答简洁，说明统计口径；如果有待确认操作，明确提示用户确认。"""


def _attachment_import_requested(user_text: str | list[dict[str, Any]]) -> bool:
    if not isinstance(user_text, list):
        return False
    text = " ".join(
        part.get("text", "")
        for part in user_text
        if isinstance(part, dict) and part.get("type") == "text"
    )
    return any(keyword in text for keyword in ("导入", "录入", "存入", "写入", "入账"))


def _content(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if content is None:
        return ""
    return json.dumps(content, ensure_ascii=False)


def run_agent(
    user_text: str | list[dict[str, Any]],
    history: list[dict[str, Any]],
    settings: dict[str, Any],
    execute_tool: Callable[[str, dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    api_key = settings.get("api_key")
    if not api_key:
        raise AgentError("尚未配置大模型 API，请先打开“AI 设置”填写 API Key")
    messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    transcript: list[dict[str, Any]] = []
    for item in history[-20:]:
        if item.get("role") in {"user", "assistant", "tool"}:
            message = {"role": item["role"], "content": item.get("content", "")}
            if item.get("tool_call_id"):
                message["tool_call_id"] = item["tool_call_id"]
            if item.get("tool_calls"):
                message["tool_calls"] = item["tool_calls"]
            messages.append(message)
    messages.append({"role": "user", "content": user_text})
    tool_events: list[dict[str, Any]] = []
    pending_action: dict[str, Any] | None = None

    for _ in range(4):
        try:
            tool_choice = {"type": "function", "function": {"name": "prepare_import_expenses"}} if _attachment_import_requested(user_text) and not tool_events else "auto"
            response = httpx.post(
                f"{settings['base_url'].rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json={"model": settings["model"], "temperature": 0, "messages": messages, "tools": TOOLS, "tool_choice": tool_choice},
                timeout=90,
            )
            response.raise_for_status()
            body = response.json()
            message = body["choices"][0]["message"]
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as error:
            raise AgentError(f"Agent 调用失败：{error}") from error

        calls = message.get("tool_calls") or []
        if not calls:
            content = _content(message)
            if not content:
                raise AgentError("大模型未返回有效回复")
            if _attachment_import_requested(user_text) and not tool_events:
                raise AgentError("模型未调用系统工具，数据未导入；请检查模型是否支持工具调用")
            return {"content": content, "tool_events": tool_events, "pending_action": pending_action, "transcript": transcript}

        assistant_message = {"role": "assistant", "content": message.get("content"), "tool_calls": calls}
        transcript.append({"role": "assistant", "content": message.get("content") or "", "tool_calls": calls})
        messages.append(assistant_message)
        for call in calls:
            function = call.get("function", {})
            name = function.get("name")
            try:
                arguments = json.loads(function.get("arguments", "{}"))
            except json.JSONDecodeError as error:
                raise AgentError(f"工具参数不是有效 JSON：{error}") from error
            if name not in {tool["function"]["name"] for tool in TOOLS} or not isinstance(arguments, dict):
                raise AgentError("大模型请求了不允许的工具或参数")
            result = execute_tool(name, arguments)
            tool_events.append({"name": name, "arguments": arguments, "result": result, "tool_call_id": call.get("id")})
            if result.get("pending_action"):
                pending_action = result["pending_action"]
            messages.append({"role": "tool", "tool_call_id": call.get("id", name), "content": json.dumps(result, ensure_ascii=False)})
            transcript.append({"role": "tool", "content": json.dumps(result, ensure_ascii=False), "tool_call_id": call.get("id", name), "tool_name": name, "tool_arguments_json": json.dumps(arguments, ensure_ascii=False), "tool_result_json": json.dumps(result, ensure_ascii=False)})

    raise AgentError("Agent 工具调用次数超过限制")
