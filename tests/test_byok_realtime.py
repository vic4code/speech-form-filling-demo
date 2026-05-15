import unittest

from app.byok import BYOKWebSocketProxy


class FakeBackendWebSocket:
    def __init__(self, events: list[dict]):
        self.events = list(events)
        self.sent: list[str] = []
        self.closed = False

    async def recv(self) -> str:
        if not self.events:
            raise RuntimeError("backend done")
        import json

        return json.dumps(self.events.pop(0))

    async def send(self, message: str) -> None:
        self.sent.append(message)

    async def close(self) -> None:
        self.closed = True


class FakeClientWebSocket:
    def __init__(self):
        self.json_messages: list[dict] = []
        self.text_messages: list[str] = []

    async def send_json(self, message: dict) -> None:
        self.json_messages.append(message)

    async def send_text(self, message: str) -> None:
        self.text_messages.append(message)


class BYOKRealtimeGuardrailTests(unittest.IsolatedAsyncioTestCase):
    def make_proxy(self) -> BYOKWebSocketProxy:
        return BYOKWebSocketProxy(
            client_ws=None,
            user_api_key="sk-test",
            litellm_url="ws://example.test",
            guardrail_enabled=True,
        )

    def test_guardrail_disables_preview_auto_response(self) -> None:
        proxy = self.make_proxy()
        event = {
            "type": "session.update",
            "session": {
                "voice": "shimmer",
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.85,
                },
            },
        }

        proxy._force_manual_response_after_guardrail(event)

        self.assertTrue(proxy._manual_response_mode)
        self.assertFalse(event["session"]["turn_detection"]["create_response"])
        self.assertNotIn("voice", event["session"])

    def test_guardrail_disables_ga_nested_auto_response(self) -> None:
        proxy = self.make_proxy()
        event = {
            "type": "session.update",
            "session": {
                "type": "realtime",
                "audio": {
                    "input": {
                        "turn_detection": {
                            "type": "server_vad",
                            "threshold": 0.85,
                        },
                    },
                },
            },
        }

        proxy._force_manual_response_after_guardrail(event)

        turn_detection = event["session"]["audio"]["input"]["turn_detection"]
        self.assertTrue(proxy._manual_response_mode)
        self.assertFalse(turn_detection["create_response"])

    async def test_transcript_pass_triggers_manual_response_create(self) -> None:
        proxy = self.make_proxy()
        proxy._manual_response_mode = True
        proxy.client_ws = FakeClientWebSocket()
        proxy.backend_ws = FakeBackendWebSocket([
            {
                "type": "conversation.item.input_audio_transcription.completed",
                "transcript": "我要申請今天往返客戶公司的計程車費",
            },
        ])

        await proxy.forward_backend_to_client()

        self.assertIn('{"type": "response.create"}', proxy.backend_ws.sent)
        self.assertEqual(proxy.client_ws.json_messages[0]["type"], "guardrail_chat")
        self.assertTrue(proxy.client_ws.json_messages[0]["passed"])
        self.assertEqual(len(proxy.client_ws.text_messages), 1)


if __name__ == "__main__":
    unittest.main()
