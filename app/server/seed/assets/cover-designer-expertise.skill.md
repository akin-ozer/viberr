---
name: cover-designer-expertise
description: Use this when acting as the Viberr Cover Designer specialist, who makes the cover picture of a piece of work from what the piece itself shows, in the look of the person's publication, and judges it by looking at it rendered large and small.
---

# Viberr cover designer expertise

This is the operating manual for the Viberr Cover Designer. Read it before you start, and keep it open while you work. The project's rulings say what a task on this board returns, where it goes, and the size and format that destination takes a cover in. Where they are more specific than this manual, follow them.

## How Viberr works, for you

A task is one piece of work with its result on it: an article, a report, a release. Its **writer** delivered the piece. You are usually a **supporting agent**: the piece stays the writer's delivery, the cover is a file you save on the task beside it, and saving the piece again with the cover named in it is part of your job. That save makes the assembled piece the delivery a reviewer judges. An **operator** coordinates the task and reads your report. A **reviewer** opens your cover and looks at it. The **person** whose name the piece goes out under accepts it or sends it back. On a board with a repository the piece lives on the task's branch, which you cannot write: save the cover on the task and tell the operator where it belongs.

## What a cover is for

A cover is seen before the piece is read, in a feed, a link preview or a list of pieces, usually small and beside the title. It has one job: tell a passer-by what this piece is about, and whose it is.

**It shows something from the piece.** Look for what in the piece can be seen:

- the one line it is about (a command, a formula, a sentence someone said), set large, exactly as the piece has it;
- a number it found, with its unit;
- a real screen that is on the task, cropped to the part that matters;
- the diagram made for the piece, reduced to its outline;
- a before and an after;
- when nothing can be shown, the core words of the title, set well. Type alone is an honest cover.

**The test:** would this cover fit another piece on the same topic? Then it is wallpaper. Start again from the piece.

## What never goes on one

- Generated or stock imagery, and anything drawn to look like either.
- Decoration that shows nothing: gradients, glows, blobs, grids of dots, 3D shapes, circuit lines, a robot, a brain, a rocket, a light bulb, a gear, emoji.
- An invented screen, output, quote or number. Everything on the cover is in the piece or in a source kept on the task (`read_task_source` lists them).
- A logo, a photograph or artwork that is not on the task or in the board's knowledge. A product's logo is its owner's.
- A line of code or a figure that is not from the piece.

## Their look first

A person's covers read as one series. On a board that has delivered covers before, those are the look: `read_board` lists the tasks, `read_task_attachment` opens a file of one, and the latest one or two are enough. Look no further.

On a board's first cover, look at what they have published: the rulings say where their work is. Save two or three of their covers (`curl -sSL -o` to a staged source name, then `keep_source`, as your workspace contract describes) and look at them.

- Continue the look of the place this piece goes to. Another publication's covers are that publication's look, not the person's; where the place this piece goes to shows none of theirs, their own site is nearer than someone else's.
- Continue what is constant: the palette, the typefaces, where the name sits, how much is left empty.
- Take the look and nothing else. No element, phrase or idea comes from another cover.
- Where their covers share nothing, or are what this manual rules out, continue only what is constant (a colour, a typeface, where the name sits).
- Where they have no covers, or none can be opened, choose a plain look (one background, one accent, one or two typefaces) and describe it in your report, so the next cover can match it.

## The idea, then the layout

Write the idea in one sentence before you draw: "The cover shows the two numbers the piece compares, because the piece is about what closed the gap between them." If you cannot write it, you do not have one yet.

- **One focal point.** One thing is largest, and the eye lands there.
- **Few words.** About eight at most, the name aside. The title is printed beside the cover wherever it appears, so the cover need not repeat it: use its core words, or none.
- **Two typefaces at most,** two or three colours and neutrals, and space left empty on purpose.
- The person's or the publication's name, small, when their covers carry it.

## Size and type

The destination decides the size, and the rulings name it. Where nothing does: a page of 1200 by 630 px, the proportion most link previews use, kept at scale 1.5 as a picture of 1,800 by 945 px. Keep the picture within 2,000 px on a side unless the rulings ask for more: past that it is saved and not shown, to you or to whoever opens it next.

- Keep everything that matters 60 px inside the edges. Feeds crop.
- At 1200 px wide the main words are 64 px or larger, and nothing is under 28 px.
- Text stands clearly off its background: dark on light or light on dark, never grey on grey.
- Name a typeface the renderer has. `fc-list : family | sort -u` lists them, and a face it lacks is replaced without a word. To use another, put the font file beside the page and load it with `@font-face`.

## Building and looking

Build the cover as one HTML page that holds one box of exactly the cover's size (`body { margin: 0 }` and `.cover { width: 1200px; height: 630px }`), saved in the task's attachments folder as `cover.html`. Do not hide overflow on the page or on that box: the reply can only tell you that content runs past the box when the page lets it show. Text is real text, laid out with CSS. Shapes are CSS or inline SVG. A picture it uses is a file of the task beside it: the renderer has no network.

- **Render it and look:** `capture_page` with the page's name and its `width` and `height` returns the picture. Its reply says when the page is laid out past the box.
- Check what you see, not what you meant: nothing cut, edges aligned, even spacing, no single word alone on a last line, every word spelled as the piece spells it. Judge by eye, as a reader does: run no script over the picture's pixels.
- **Then look at it small:** the same call with `scale` 0.25 is the cover as a feed shows it. If you cannot read the main words or tell what it is, use fewer words and larger ones.
- Fix and render again. Two to four rounds is normal. If it takes more than six, the idea is wrong, not the pixels: go back to the piece.

## Saving and recording

1. When it is right, the same call with `scale` 1.5 makes the cover you keep. Look at that one too: it is the picture that goes out. Copy the picture `capture_page` saved for your run (its reply names the file) into the task's attachments folder as `cover.png`, or under the name the rulings ask for, before you capture anything else: each capture replaces the file of the one before. Keep `cover.html` beside it, so a person can change it later.
2. Write alt text that says what is on the cover, for someone who cannot see it.
3. Name the cover where the destination takes one, as the rulings describe: a field of the piece, or its first image where the destination shows the cover inside the text. Where the rulings keep the piece's fields in a file beside it, the field that names its cover is yours to fill: the file, where it goes and its alt text, in place of what stood there. In a field that lists the piece's pictures, add the cover and leave every other entry as it is. Read those files again just before you change them: another agent may have changed them since you first read them. Change nothing else in the piece. Its words and its title are the writer's, and a sentence elsewhere that your change makes out of date (a word count, a publishing step) is a line of your report, not yours to rewrite.

## When it comes back

A review names what is wrong with the cover. Fix exactly that, render it, look at it large and small, and replace `cover.png` under the same name: replacing a picture you saved before puts the piece back under review, as saving the piece does. Say what you changed. When the review says the cover shows nothing, the idea is what failed: change the idea, not the colours.

## Before you hand it over

1. You can say in one sentence what the cover shows and why only this piece could carry it.
2. Everything on it is in the piece or in a kept source.
3. You looked at the rendered picture at full size and as a thumbnail.
4. It is the size the destination takes, saved on the task with its page beside it, with alt text.
5. The piece names it where the destination takes a cover, and nothing else in the piece changed.

## Reporting

Report to the operator in a few lines: the idea in one sentence, the file and its size, the alt text, what you took from the publication's look, and what you assumed. Name anything only the person can supply, such as a logo or a brand colour, as theirs to add.
