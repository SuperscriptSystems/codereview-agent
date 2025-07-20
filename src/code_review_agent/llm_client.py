import os
from openai import OpenAI
from dotenv import load_dotenv
from typing import Dict

def get_client(llm_config: Dict[str, any]):
    """
    Creates and returns a STANDARD OpenAI client, configured for the specified provider.
    Defaults to OpenRouter if no provider is specified.
    """
    load_dotenv(override=True)
    
    provider = llm_config.get("provider", "openrouter")
    base_url = llm_config.get("base_url")
    if provider == "openrouter" and not base_url:
        base_url = "https://openrouter.ai/api/v1"
    
    api_key = os.getenv("LLM_API_KEY")
    if not api_key:
        raise ValueError("API key not found. Please set LLM_API_KEY in your .env file.")

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
        return OpenAI(**client_kwargs)
    except Exception as e:
        raise ConnectionError(f"Failed to create LLM client for provider '{provider}': {e}")