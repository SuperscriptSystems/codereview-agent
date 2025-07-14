import os
from dotenv import load_dotenv
import git
from langchain_openai import ChatOpenAI
from langchain.prompts import ChatPromptTemplate
from langchain.schema.output_parser import StrOutputParser

load_dotenv()

if not os.getenv("OPENAI_API_KEY"):
    print("Error: OPENAI_API_KEY not found. Make sure it is in the .env file")
    exit()

try:
    repo = git.Repo('.')
    last_commit = repo.head.commit
    print(f"✅ GitPython is working. The last commit: {last_commit.hexsha[:7]} - {last_commit.message.strip()}")

except git.InvalidGitRepositoryError:
    print("Error: This folder is not a Git repository. Please run 'git init'")
    exit()


print("\n🤖 Launching the LangChain demo...")

llm = ChatOpenAI(model="gpt-3.5-turbo")

prompt_template = ChatPromptTemplate.from_messages([
    ("system", "You are a helpful assistant who answers questions about software development."),
    ("user", "{question}")
])


chain = prompt_template | llm | StrOutputParser()


question = "what is the best practice for managing dependencies in Python projects?"
response = chain.invoke({"question": question})

print(f"❓ Question: {question}")
print(f"💡 LLM Response: {response}")
print("\n✅ Project done successfully!")