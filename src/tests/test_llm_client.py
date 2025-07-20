from code_review_agent.llm_client import get_client

def test_get_client_configures_for_openrouter_by_default(mocker):
    mock_openai = mocker.patch('code_review_agent.llm_client.OpenAI')

    get_client({})

    mock_openai.assert_called_once()
    call_kwargs = mock_openai.call_args.kwargs
    
    assert call_kwargs['base_url'] == "https://openrouter.ai/api/v1"
    assert "HTTP-Referer" in call_kwargs['default_headers']

def test_get_client_configures_for_openai_when_specified(mocker):
    mock_openai = mocker.patch('code_review_agent.llm_client.OpenAI')

    get_client({"provider": "openai"})

    mock_openai.assert_called_once()
    call_kwargs = mock_openai.call_args.kwargs

    assert call_kwargs['base_url'] is None
    assert 'default_headers' not in call_kwargs