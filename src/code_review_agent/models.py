from pydantic import BaseModel, Field
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
    line_number: int = Field(..., description="The relevant line number in the file for the issue.")
    issue_type: IssueType = Field(..., description="The category of the issue.")
    comment: str = Field(..., description="A detailed, constructive comment about the issue.")
    suggestion: Optional[str] = Field(
        None, description="If applicable, a direct code suggestion to fix the issue."
    )

class ReviewResult(BaseModel):
    issues: List[CodeIssue] = Field(..., description="A list of all issues found in a single file.")

    def is_ok(self) -> bool:
        return not self.issues
