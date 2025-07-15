import os
from openai import OpenAI
import instructor
from dotenv import load_dotenv

def get_client(provider: str):
    load_dotenv()
    if provider == "openai":
        if not os.getenv("OPENAI_API_KEY"):
            raise ValueError("OPENAI_API_KEY is not set in .env file.")
        return instructor.patch(OpenAI())
    else:
        raise ValueError(f"Unsupported LLM provider: {provider}")