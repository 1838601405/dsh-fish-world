"""鱼世界桥：把 AstrBot 的 QQ 能力借给 DSH 的鱼世界。

设计要点
--------
* 只监听本机 127.0.0.1，全部接口要求 Bearer token，不做公网暴露。
* 用 AstrBot aiocqhttp 适配器内部的 `bot.call_action()` 转发 OneBot 动作，
  属于全量透传：群历史、合并转发、戳一戳、get_cookies 都能过。
* 收到的消息缓存在内存队列里，由 DSH 侧轮询 `/events` 取走。
  这样做是因为鱼的 DSH 端口会变，反向配置会让主人在两边都要填地址。
* 身份（登录号 / 主人会话）从真实收到的事件里记，不猜适配器内部字段。

已知边界
--------
本插件依赖 AstrBot 的公开插件接口。凡是不确定的地方一律用特性检测并降级，
让失败表现为一条明确的错误信息，而不是抛栈或静默卡住。
"""

from __future__ import annotations

import asyncio
import hmac
import secrets
import time
from collections import deque
from typing import Any

from aiohttp import web

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register

PLUGIN_NAME = "astrbot_plugin_fish_world_bridge"
DEFAULT_PORT = 6210
MAX_EVENTS = 200


@register(
    PLUGIN_NAME,
    "1838601405",
    "鱼世界桥：让 DSH 的鱼世界把 AstrBot 当作 QQ 通道，并可借用 Agent 能力。",
    "v0.1.0",
)
class FishWorldBridge(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._listening = False
        # 消息队列：DSH 用游标轮询，取走就推进游标。
        self._events: deque[dict[str, Any]] = deque(maxlen=MAX_EVENTS)
        self._cursor = 0
        # 从真实事件里记住的身份信息。
        self._self_id = ""
        self._self_name = ""
        self._last_umo = ""

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------
    async def initialize(self) -> None:
        cfg = self._config()
        if not cfg.get("enabled", True):
            logger.info("[fish-world] 桥插件未启用，跳过监听")
            return
        token = self._ensure_token(cfg)
        if not token:
            logger.warning("[fish-world] 没有 token，出于安全考虑不启动 HTTP 服务")
            return
        await self._start_server(int(cfg.get("port") or DEFAULT_PORT))

    async def terminate(self) -> None:
        await self._stop_server()

    # ------------------------------------------------------------------
    # 配置
    # ------------------------------------------------------------------
    def _config(self) -> dict[str, Any]:
        """读取本插件配置。读不到就给一套安全的默认值。"""
        try:
            data = self.context.get_config()
            # AstrBotConfig 是 dict 子类，直接用下标访问即可。
            section = data.get(PLUGIN_NAME) if hasattr(data, "get") else None
            return dict(section or {})
        except Exception as error:  # pragma: no cover
            logger.debug(f"[fish-world] 读取配置失败，使用默认值：{error}")
            return {}

    def _ensure_token(self, cfg: dict[str, Any]) -> str:
        token = str(cfg.get("token") or "").strip()
        if token:
            return token
        # 第一次启动自动生成并写回配置，省得主人去猜。
        token = "fw_" + secrets.token_hex(24)
        try:
            data = self.context.get_config()
            data[PLUGIN_NAME] = {**cfg, "token": token}
            # save_config 是 AstrBotConfig 实例上的方法（不是 dict 的方法）。
            save = getattr(data, "save_config", None)
            if callable(save):
                save()
            logger.info("[fish-world] 已生成桥 token，请到插件配置里复制到鱼世界")
        except Exception as error:  # pragma: no cover
            logger.warning(f"[fish-world] 无法写回 token，本次仅在内存中生效：{error}")
        return token

    # ------------------------------------------------------------------
    # HTTP 服务
    # ------------------------------------------------------------------
    async def _start_server(self, port: int) -> None:
        # 中间件用闭包定义：aiohttp 要求中间件是普通可调用对象，
        # 绑定方法虽然多数版本能用，但依赖内部属性透传，不够稳。
        @web.middleware
        async def auth_middleware(request: web.Request, handler):
            # CORS 预检不需要 token，但也绝不带数据出去。
            if request.method == "OPTIONS":
                return web.json_response({}, status=204)
            expected = str(self._config().get("token") or "").strip()
            provided = request.headers.get("Authorization", "").replace("Bearer ", "", 1).strip()
            # 用 bytes 比较：compare_digest 遇到非 ASCII 的 str 会抛 TypeError。
            if not expected or not hmac.compare_digest(
                expected.encode("utf-8"), provided.encode("utf-8")
            ):
                return web.json_response({"ok": False, "error": "unauthorized"}, status=403)
            return await handler(request)

        app = web.Application(middlewares=[auth_middleware])
        app.router.add_get("/health", self._handle_health)
        app.router.add_post("/onebot", self._handle_onebot)
        app.router.add_get("/events", self._handle_events)
        app.router.add_get("/tools", self._handle_tools)
        app.router.add_post("/agent", self._handle_agent)

        try:
            self._runner = web.AppRunner(app, access_log=None)
            await self._runner.setup()
            self._site = web.TCPSite(self._runner, "127.0.0.1", port)
            await self._site.start()
            self._listening = True
            logger.info(f"[fish-world] 桥已监听 http://127.0.0.1:{port}")
        except Exception as error:
            logger.error(f"[fish-world] 启动 HTTP 服务失败（端口 {port}）：{error}")
            await self._stop_server()

    async def _stop_server(self) -> None:
        self._listening = False
        try:
            if self._site is not None:
                await self._site.stop()
        except Exception:
            pass
        try:
            if self._runner is not None:
                await self._runner.cleanup()
        except Exception:
            pass
        self._site = None
        self._runner = None

    async def _handle_health(self, request: web.Request) -> web.Response:
        bot = self._find_bot()
        return web.json_response(
            {
                "ok": bot is not None,
                "status": "ok" if bot else "no-adapter",
                "version": "0.1.0",
                "listening": self._listening,
                "userId": self._self_id,
                "nickname": self._self_name,
                "ownerUmo": self._last_umo,
                "hasAdapter": bot is not None,
            }
        )

    async def _handle_onebot(self, request: web.Request) -> web.Response:
        """转发一次 OneBot 动作到 AstrBot 的 aiocqhttp 适配器。"""
        try:
            body = await request.json()
        except Exception:
            return web.json_response(
                {"status": "failed", "retcode": -1, "data": {}, "message": "invalid json"},
                status=400,
            )

        action = str(body.get("action") or "").strip()
        params = body.get("params")
        if not action:
            return web.json_response(
                {"status": "failed", "retcode": -1, "data": {}, "message": "missing action"},
                status=400,
            )
        if not isinstance(params, dict):
            params = {}

        bot = self._find_bot()
        if bot is None:
            return web.json_response(
                {"status": "failed", "retcode": -1, "data": {}, "message": "aiocqhttp adapter not available"},
                status=503,
            )

        try:
            # 不同 astrbot 版本这里可能是 awaitable，也可能直接返回值。
            result = bot.call_action(action, **params)
            if asyncio.iscoroutine(result):
                result = await asyncio.wait_for(result, timeout=120)
        except asyncio.TimeoutError:
            return web.json_response(
                {"status": "failed", "retcode": -1, "data": {}, "message": "onebot action timeout"},
                status=504,
            )
        except Exception as error:
            logger.warning(f"[fish-world] OneBot 动作 {action} 失败：{error}")
            return web.json_response(
                {"status": "failed", "retcode": -1, "data": {}, "message": str(error)[:200]},
                status=502,
            )

        return web.json_response(self._normalize_onebot_result(result))

    async def _handle_events(self, request: web.Request) -> web.Response:
        try:
            since = int(request.query.get("since", "0"))
        except ValueError:
            since = 0
        # 游标 0 / 负数表示"从现在起"，避免刚接上就补一屋子历史消息。
        start = max(since, 0)
        pending = [e for e in self._events if int(e.get("cursor", 0)) > start]
        return web.json_response(
            {
                "ok": True,
                "events": pending[:100],
                "cursor": self._cursor,
            }
        )

    async def _handle_tools(self, request: web.Request) -> web.Response:
        """列出 AstrBot 里可借用的工具（只读，给鱼世界的界面看）。"""
        tools: list[dict[str, Any]] = []
        seen: set[str] = set()
        try:
            manager = self.context.get_llm_tool_manager()
            for tool in getattr(manager, "func_list", []) or []:
                name = str(getattr(tool, "name", "") or "")
                if not name or name in seen:
                    continue
                seen.add(name)
                tools.append(
                    {
                        "name": name,
                        "description": str(getattr(tool, "description", "") or "")[:400],
                        "origin": "plugin",
                    }
                )
        except Exception as error:
            logger.debug(f"[fish-world] 读取工具列表失败：{error}")
            return web.json_response({"ok": False, "error": str(error)[:200], "tools": []}, status=503)
        return web.json_response({"ok": True, "tools": tools})

    async def _handle_agent(self, request: web.Request) -> web.Response:
        """借用 AstrBot 的 Agent 生成一段回复。

        只走 `llm_generate`：它不会自动执行工具，避免鱼在无人监督时触发别的插件。
        想借用插件工具，需要用户在鱼世界里显式打开对应开关，届时再扩展这里。
        """
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid json"}, status=400)

        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            return web.json_response({"ok": False, "error": "missing prompt"}, status=400)
        system_prompt = str(body.get("systemPrompt") or "").strip()

        try:
            provider_id = self.context.get_current_chat_provider_id(self._last_umo or None)
        except Exception:
            provider_id = None
        if not provider_id:
            return web.json_response(
                {"ok": False, "error": "AstrBot 还没有可用的对话模型提供商"}, status=503
            )

        try:
            generate = getattr(self.context, "llm_generate", None)
            if not callable(generate):
                return web.json_response(
                    {"ok": False, "error": "当前 AstrBot 版本不支持 llm_generate"}, status=503
                )
            response = await asyncio.wait_for(
                generate(
                    chat_provider_id=provider_id,
                    prompt=prompt[:8000],
                    system_prompt=system_prompt[:4000] or None,
                ),
                timeout=120,
            )
        except asyncio.TimeoutError:
            return web.json_response({"ok": False, "error": "生成超时"}, status=504)
        except Exception as error:
            logger.warning(f"[fish-world] Agent 生成失败：{error}")
            return web.json_response({"ok": False, "error": str(error)[:200]}, status=502)

        text = ""
        for attr in ("text", "completion_text", "content"):
            value = getattr(response, attr, None)
            if isinstance(value, str) and value.strip():
                text = value.strip()
                break
        if not text:
            text = str(response or "")[:4000]

        return web.json_response(
            {"ok": True, "text": text, "usedTools": False, "model": str(provider_id)}
        )

    # ------------------------------------------------------------------
    # 适配器 / 结果处理
    # ------------------------------------------------------------------
    def _find_bot(self):
        """找到 aiocqhttp 适配器暴露的 OneBot 客户端。

        用 meta().name 判断类型，不猜实例 id —— 那个 id 是用户在 WebUI 里随手填的。
        """
        try:
            insts = getattr(self.context.platform_manager, "platform_insts", []) or []
        except Exception:
            return None
        for inst in insts:
            try:
                meta = inst.meta()
                if str(getattr(meta, "name", "")) != "aiocqhttp":
                    continue
            except Exception:
                continue
            bot = getattr(inst, "bot", None)
            if bot is not None and hasattr(bot, "call_action"):
                return bot
        return None

    @staticmethod
    def _normalize_onebot_result(result: Any) -> dict[str, Any]:
        """把协议端各种返回形态归一成 OneBot 11 的 {status, retcode, data, message}。"""
        if isinstance(result, dict):
            data = result.get("data")
            status = result.get("status")
            retcode = result.get("retcode")
            ok = status == "ok" or retcode == 0
            return {
                "status": "ok" if ok else (status or "failed"),
                "retcode": 0 if ok else (retcode if isinstance(retcode, int) else -1),
                "data": data if data is not None else {},
                "message": "" if ok else str(result.get("message") or result.get("wording") or "")[:200],
            }
        return {"status": "ok", "retcode": 0, "data": result, "message": ""}

    # ------------------------------------------------------------------
    # 收消息：记身份 + 入队
    # ------------------------------------------------------------------
    @filter.event_message_type(filter.EventMessageType.ALL)
    async def _observe(self, event: AstrMessageEvent):
        """只是旁听，不产生任何回复，也不阻断其他插件。"""
        try:
            self_id = str(event.get_self_id() or "")
            if self_id:
                self._self_id = self_id
            self._last_umo = str(getattr(event, "unified_msg_origin", "") or "")

            text = str(getattr(event, "message_str", "") or "")
            chat_key = self._chat_key_of(event)
            uid = str(event.get_sender_id() or "")
            nickname = ""
            try:
                nickname = str(event.get_sender_name() or "")
            except Exception:
                pass

            self._cursor += 1
            message_obj = getattr(event, "message_obj", None)
            # AstrMessageEvent 上没有统一的 message_id，各适配器字段名不一致；
            # 用游标当 id，既稳定又不需要猜字段。
            raw_id = ""
            for attr in ("message_id", "id"):
                value = getattr(message_obj, attr, None)
                if value not in (None, ""):
                    raw_id = str(value)
                    break
            self._events.append(
                {
                    "cursor": self._cursor,
                    "id": raw_id or f"cursor-{self._cursor}",
                    "chatKey": chat_key,
                    "text": text,
                    "userId": uid,
                    "nickname": nickname,
                    "at": int(time.time() * 1000),
                    "images": [],
                    "parts": [{"kind": "text", "text": text}] if text else [],
                }
            )
        except Exception as error:  # pragma: no cover
            logger.debug(f"[fish-world] 旁听消息失败：{error}")
        # 不 yield 任何东西：既不回复，也不改变事件流向。

    @staticmethod
    def _chat_key_of(event: AstrMessageEvent) -> str:
        try:
            group = event.get_group_id()
            if group:
                return f"group:{group}"
        except Exception:
            pass
        try:
            uid = event.get_sender_id()
            if uid:
                return f"private:{uid}"
        except Exception:
            pass
        return ""
