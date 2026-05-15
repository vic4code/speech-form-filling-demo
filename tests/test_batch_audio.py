import base64
import unittest

from pydantic import BaseModel, Field, ValidationError

from app.main import (
    decode_audio_payload,
    format_form_review,
    format_validation_errors,
    openai_audio_error_message,
)


class BatchAudioTests(unittest.TestCase):
    def test_decode_audio_payload_accepts_data_url(self) -> None:
        raw = b"audio-bytes"
        payload = "data:audio/webm;codecs=opus;base64," + base64.b64encode(raw).decode()

        audio = decode_audio_payload(payload, "")

        self.assertEqual(audio.bytes, raw)
        self.assertEqual(audio.mime_type, "audio/webm")
        self.assertEqual(audio.filename, "recording.webm")

    def test_format_form_review_renders_nested_payload(self) -> None:
        text = format_form_review(
            {
                "rideDate": "2026-05-12",
                "rideRows": [{"from": "公司", "to": "客戶端", "fee": "320"}],
                "notes": "",
            }
        )

        self.assertIn("rideDate: 2026-05-12", text)
        self.assertIn("rideRows:", text)
        self.assertIn("- from: 公司", text)
        self.assertIn("notes: ", text)

    def test_openai_audio_error_message_mentions_unsupported_audio(self) -> None:
        class Error:
            message = "Audio file might be corrupted or unsupported"

        message = openai_audio_error_message(Error())

        self.assertIn("錄音格式", message)
        self.assertIn("太短", message)

    def test_format_validation_errors_summarizes_missing_fields(self) -> None:
        class Payload(BaseModel):
            reason: str = Field(min_length=1)
            timeRange: str = Field(min_length=1)

        try:
            Payload.model_validate({"reason": "", "timeRange": ""})
        except ValidationError as exc:
            errors = format_validation_errors(exc)
        else:
            self.fail("expected validation error")

        self.assertEqual(errors, ["缺少欄位：reason", "缺少欄位：timeRange"])
