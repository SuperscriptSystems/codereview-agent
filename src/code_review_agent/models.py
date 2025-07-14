from pydantic import BaseModel, Field
from typing import List, Literal

IssueType = Literal[
    "LogicError",
    "CodeStyle",
    "TestCoverage",
    "Security",
    "Suggestion",
    "Other"
]

class CodeIssue(BaseModel):

    line_number: int = Field(..., description="The line number the issue pertains to.")
    issue_type: IssueType = Field(..., description="The type of the identified issue.")
    comment: str = Field(..., description="A detailed comment explaining the issue and suggesting a fix.")

class ReviewResult(BaseModel):
    """
    Represents the final review result for a single file,
    containing a list of all found issues.
    """
    issues: List[CodeIssue] = Field(..., description="A list of code issues found in the file.")

    def is_ok(self) -> bool:

        return not self.issues