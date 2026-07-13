import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StereoMeter } from "./StereoMeter";

describe("StereoMeter", () => {
  it("renders independent accessible left and right levels", () => {
    const { container } = render(<StereoMeter levels={[0.25, 0.75]} />);
    expect(screen.getByLabelText("L level 25 percent")).toBeInTheDocument();
    expect(screen.getByLabelText("R level 75 percent")).toBeInTheDocument();
    const rows = container.querySelectorAll(".meter-row");
    expect(rows[0].querySelectorAll(".active")).toHaveLength(8);
    expect(rows[1].querySelectorAll(".active")).toHaveLength(24);
  });
});
