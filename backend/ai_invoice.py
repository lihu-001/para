"""Multimodal invoice parsing through an OpenAI-compatible API."""

import base64
import json
from typing import Any, Callable

import httpx


class AIConfigurationError(RuntimeError):
    pass


def parse_invoice_images(images: list[bytes], mime_type: str, load_settings: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    config = load_settings()
    api_key = config.get("api_key")
    if not api_key:
        raise AIConfigurationError("尚未配置大模型 API，请先打开“AI 设置”填写 API Key")
    content: list[dict[str, Any]] = [{"type": "text", "text": (
        "请解析这些发票页面，只返回 JSON，不要 Markdown。字段要求："
        "invoice_type, invoice_code, invoice_number, issue_date(YYYY-MM-DD), "
        "seller_name, seller_tax_number, buyer_name, buyer_tax_number, "
        "total_amount_minor(整数分), tax_exclusive_amount_minor, tax_amount_minor, "
        "currency, confidence(对象), warnings(数组)。"
        "购买方和销售方只提取公司名称与税号；无法确认的字段返回 null；不要猜测金额。"
    )}]
    for image in images:
        encoded = base64.b64encode(image).decode("ascii")
        content.append({"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{encoded}"}})
    payload = {"model": config["model"], "temperature": 0, "response_format": {"type": "json_object"}, "messages": [{"role": "user", "content": content}]}
    try:
        response = httpx.post(f"{config['base_url']}/chat/completions", headers={"Authorization": f"Bearer {api_key}"}, json=payload, timeout=90)
        response.raise_for_status()
        parsed = json.loads(response.json()["choices"][0]["message"]["content"])
    except (httpx.HTTPError, KeyError, IndexError, json.JSONDecodeError) as error:
        raise AIConfigurationError(f"大模型发票解析失败：{error}") from error
    if not isinstance(parsed, dict):
        raise AIConfigurationError("大模型未返回发票对象")
    amount = parsed.get("total_amount_minor")
    if type(amount) is not int or amount <= 0 or not parsed.get("issue_date") or not parsed.get("seller_name"):
        raise AIConfigurationError("大模型未返回有效的发票金额、日期或销售方")
    return parsed
