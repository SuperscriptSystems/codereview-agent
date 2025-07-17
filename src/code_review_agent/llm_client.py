import os
from openai import OpenAI
import instructor
from dotenv import load_dotenv
from typing import Dict

def get_client(llm_config: Dict[str, any]):
    """
    Creates and returns a patched LLM client based on the provided configuration.
    It can connect to OpenAI or any OpenAI-compatible API like OpenRouter.
    """
    load_dotenv(override=True)
    
    provider = llm_config.get("provider", "openai")
    
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("API key not found. Please set OPENAI_API_KEY in your .env file.")

    base_url = llm_config.get("base_url", None)

    client_kwargs = {
        'base_url': base_url,
        'api_key': api_key,
    }

    if provider == "openrouter":
        client_kwargs['default_headers'] = {
            "HTTP-Referer": "https://github.com/ExilionTechnologies/CodeReviewAgent",
            "X-Title": "Code Review Agent", 
        }

    try:
        client = OpenAI(**client_kwargs)
        return instructor.patch(client)

    except Exception as e:
        raise ConnectionError(f"Failed to create LLM client for provider '{provider}': {e}")