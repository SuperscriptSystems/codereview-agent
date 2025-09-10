from pydantic import BaseModel, Field, field_validator, ValidationInfo, AliasChoices
from typing import List, Literal, Optional

class ContextRequirements(BaseModel):
    required_additional_files: List[str] = Field(
        ..., description="A list of absolute file paths needed to understand the change. Can be empty."
    )
    is_sufficient: bool = Field(
        ..., description="Set to true if the current context is sufficient and no more files are needed."
    )
    reasoning: str = Field(
        ..., description="A brief explanation of why the additional files are needed or why the context is sufficient."
    )

IssueType = Literal[
    "LogicError", 
    "CodeStyle", 
    "Security", 
    "Suggestion", 
    "TestCoverage", 
    "Clarity", 
    "Performance", 
    "Other"
]

class CodeIssue(BaseModel):
    line_number: int
    issue_type: IssueType
    comment: str
    suggestion: Optional[str] = None
class ReviewResult(BaseModel):
    issues: List[CodeIssue] = Field(..., description="A list of all issues found in a single file.")

    def is_ok(self) -> bool:
        return not self.issues


class TaskRelevance(BaseModel):
    score: int = Field(
        ..., 
        description="A score from 0 to 100 representing how related the code change is to the Jira task.",
        ge=0,
        le=100 
    )
    justification: str = Field(
        ...,
        description="A brief, one-sentence justification for the score."
    )

class MergeSummary(BaseModel):
    relevance_score: int = Field(..., description="A score from 0 to 100 representing how related the code change is to the Jira task.")
    relevance_justification: str = Field(..., description="A brief justification for the relevance score.")
    
    db_tables_created: List[str] = Field(default=[], description="List of new database tables created.")
    db_tables_modified: List[str] = Field(default=[], description="List of existing database tables modified (e.g., added/removed columns).")
    
    api_endpoints_added: List[str] = Field(default=[], description="List of new API endpoints added (e.g., 'GET /api/users').")
    api_endpoints_modified: List[str] = Field(default=[], description="List of modified API endpoints.")
    
    commit_summary: str = Field(..., description="A brief, high-level summary of all commit messages.")    