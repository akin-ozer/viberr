import { Icon } from "./icon";

/**
 * Page controls laid out the way shadcn/ui's Pagination draws them (ruling
 * 614): Previous, the page numbers with a gap where a run is skipped, Next.
 * The registry component is a design reference, read the way
 * `design/html-app` is, never an install (ruling 166): this renders with the
 * sheet's own `.pager*` classes.
 *
 * Pages are 1-based. An end with no page past it is `aria-disabled`, not
 * `disabled`: a disabled button drops the focus of a keyboard user whose
 * press on Next just reached the last page.
 */

/** At most this many numbered slots, gaps included, so the control keeps one
 *  width while the reader pages through. */
const SLOTS = 7;

/** The numbers to draw, `null` standing for a skipped run: the first and last
 *  page, the current one and its neighbours, and near either end the pages
 *  that keep the count at SLOTS. */
function pageSlots(page: number, pages: number): (number | null)[] {
  if (pages <= SLOTS) return Array.from({ length: pages }, (_, i) => i + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, null, pages];
  if (page >= pages - 3) return [1, null, pages - 4, pages - 3, pages - 2, pages - 1, pages];
  return [1, null, page - 1, page, page + 1, null, pages];
}

export function Pagination({
  page,
  pages,
  label,
  onPage,
}: {
  /** The page on screen, 1-based. */
  page: number;
  pages: number;
  /** Names the landmark, e.g. "Custom stage pages". */
  label: string;
  onPage: (page: number) => void;
}) {
  const go = (to: number) => {
    if (to >= 1 && to <= pages && to !== page) onPage(to);
  };
  return (
    <nav className="pager" aria-label={label}>
      <ul className="pager-list">
        <li>
          <button
            type="button"
            className="pager-btn pager-step"
            aria-label="Previous page"
            aria-disabled={page <= 1 || undefined}
            onClick={() => go(page - 1)}
          >
            <Icon name="chevron" className="pager-back" />
            <span className="pager-word">Previous</span>
          </button>
        </li>
        {pageSlots(page, pages).map((slot, i) =>
          slot === null ? (
            // The gap is drawn, not read: the page numbers either side of it
            // already say which run it skips.
            <li key={"gap-" + i} aria-hidden="true">
              <span className="pager-gap">…</span>
            </li>
          ) : (
            <li key={slot}>
              <button
                type="button"
                className="pager-btn"
                aria-label={"Page " + slot}
                aria-current={slot === page ? "page" : undefined}
                onClick={() => go(slot)}
              >
                {slot}
              </button>
            </li>
          ),
        )}
        <li>
          <button
            type="button"
            className="pager-btn pager-step"
            aria-label="Next page"
            aria-disabled={page >= pages || undefined}
            onClick={() => go(page + 1)}
          >
            <span className="pager-word">Next</span>
            <Icon name="chevron" />
          </button>
        </li>
      </ul>
    </nav>
  );
}
