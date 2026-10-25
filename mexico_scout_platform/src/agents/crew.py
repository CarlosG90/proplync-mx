"""Main crew orchestration: sourcing first, then financial analysis.

WHY SEQUENTIAL
The analyst can only evaluate what the sourcing agent stored, so the second task takes the first as context. A hierarchical
crew would add a manager LLM call per step, which is the wrong trade on a small local model.
"""

from __future__ import annotations

from typing import Any

from crewai import Crew, Process
from loguru import logger

from src.agents.definitions import ToolContext, build_agents, build_tasks, configure_tools
from src.config import Settings
from src.models import SearchBrief


class ScoutCrew:
    def __init__(self, settings: Settings, ctx: ToolContext) -> None:
        self.settings = settings
        self.ctx = ctx
        configure_tools(ctx)

    def run(self, brief: SearchBrief) -> dict[str, Any]:
        """Run both agents. Returns the dossier text plus the machine-readable numbers recorded by the tools."""
        sourcing, analyst = build_agents(self.settings)
        sourcing_task, analyst_task = build_tasks(brief, sourcing, analyst, self.settings.usd_mxn_rate)
        crew = Crew(
            agents=[sourcing, analyst], tasks=[sourcing_task, analyst_task], process=Process.sequential,
            verbose=self.settings.agent_verbose, memory=False, cache=True,
        )
        logger.info("Starting the crew for brief: {}", brief.model_dump_json())
        output = crew.kickoff()
        return {
            "dossier_markdown": str(getattr(output, "raw", output)),
            "saved_urls": list(self.ctx.saved_urls),
            "reports": dict(self.ctx.reports),
        }
