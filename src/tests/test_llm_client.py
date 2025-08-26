import pytest
from code_review_agent.llm_client import get_client

def test_get_client_configures_for_openrouter_by_default(mocker):
    """
    Tests that get_client correctly configures for OpenRouter when no config is provided.
    """
    mock_openai_class = mocker.patch('code_review_agent.llm_client.OpenAI')


    get_client({})

    mock_openai_class.assert_called_once()
    
    call_kwargs = mock_openai_class.call_args.kwargs
    
    assert call_kwargs['base_url'] == "https://openrouter.ai/api/v1"
    assert "HTTP-Referer" in call_kwargs['default_headers']
    assert "X-Title" in call_kwargs['default_headers']

def test_get_client_configures_for_openai_when_specified(mocker):
    """
    Tests that get_client correctly configures for OpenAI when specified in the config.
    """

    mock_openai_class = mocker.patch('code_review_agent.llm_client.OpenAI')
    

    get_client({"provider": "openai"})

    mock_openai_class.assert_called_once()
    call_kwargs = mock_openai_class.call_args.kwargs
    
    assert call_kwargs['base_url'] == "https://api.openai.com/v1"

    assert 'default_headers' not in call_kwargs

def test_get_client_uses_custom_base_url_if_provided(mocker):
    """
    Tests that a custom base_url from the config overrides defaults.
    """

    mock_openai_class = mocker.patch('code_review_agent.llm_client.OpenAI')
    custom_url = "http://localhost:1234/v1"
    

    get_client({"provider": "openrouter", "base_url": custom_url})

    mock_openai_class.assert_called_once()
    call_kwargs = mock_openai_class.call_args.kwargs
    
    assert call_kwargs['base_url'] == custom_url