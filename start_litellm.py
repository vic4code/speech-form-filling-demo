"""Start LiteLLM proxy with config — workaround for Python 3.14 + uvloop incompatibility."""
import asyncio
import uvicorn
from litellm.proxy.proxy_server import app, initialize

async def main():
    await initialize(config="litellm_config.yaml")
    config = uvicorn.Config(app, host="127.0.0.1", port=4000, loop="asyncio")
    server = uvicorn.Server(config)
    await server.serve()

if __name__ == "__main__":
    asyncio.run(main())
