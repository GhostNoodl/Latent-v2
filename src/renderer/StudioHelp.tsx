import { Notice } from './ui';
import './studio-help.css';

/** Content for the Help modal. Every disclosure is keyboard-focusable. */
export function StudioHelp() {
  return (
    <div className="studio-help">
      <ol className="help-steps">
        <li>
          Open <strong>Setup</strong> (it pops up on first launch) and install the image engine. Latent starts it for
          you from then on.
        </li>
        <li>
          In <strong>Models</strong>, add an SDXL or Illustrious checkpoint, or grab one from <strong>Discover</strong>.
          LoRAs need to match the checkpoint's family.
        </li>
        <li>
          In <strong>Create</strong>, pick your model, write a prompt and hit Generate (or press{' '}
          <strong>Ctrl+Enter</strong>).
        </li>
        <li>
          Click a thumbnail to look at it. Right-click it and choose <strong>Reuse settings</strong> to load its exact
          settings. <strong>Undo</strong> takes you back to what you had before.
        </li>
      </ol>
      <Notice>
        Looking at an old image never changes your prompt, and reusing settings never starts a generation.
      </Notice>
      <details>
        <summary>History, variations and missing models</summary>
        <p>
          The arrows next to your history page through older images. Library has search and collections. On a thumbnail,
          Shift+F10 opens its menu and Delete moves it to the Recycle Bin.
        </p>
        <p>
          Make a variation picks a new seed and rerolls any random prompt choices. If an image used a model you no
          longer have, put the file back or pick a replacement. The same settings can still give slightly different
          pixels after an engine update.
        </p>
      </details>
      <details>
        <summary>Source images and extra tools</summary>
        <p>
          Import an image, or use the one on the canvas, as a starting point. To edit part of it, paint a mask: white
          gets changed, black stays the same. Masks work with a batch size of 1. Extra tools tell you what they need to
          download and which options don't mix. A size being allowed doesn't guarantee it fits in your GPU's memory.
        </p>
        <p>
          LoRA trigger words are kept apart from what you type. Help me write suggests prompts on your PC, and Apply
          only changes the prompts, with Undo if you don't like it.
        </p>
      </details>
      <details>
        <summary>Editing with Qwen</summary>
        <p>
          Edit with Qwen opens its own editor. Clicking an older version just shows it. Continue or Branch makes it the
          next image to edit, and Reuse exact recipe loads the settings that made it. Qwen has its own Undo. Deleting an
          editor draft keeps the images it made in your Library.
        </p>
        <p>Base and Fast are two different setups. Try both and keep whichever you like better.</p>
      </details>
      <details>
        <summary>Downloads, folders and what Latent remembers</summary>
        <p>
          Settings shows where everything lives and how much space it takes. Cancel stops a download, and Retry / Resume
          picks it back up where it can. Old links sometimes expire, so you may need a fresh one. Optional extras are
          only downloaded when you ask for them.
        </p>
        <p>
          Collections group images without moving any files. Model folders can also read models from folders you already
          have elsewhere, without changing them. Finish or cancel what's in the queue before moving folders.
        </p>
        <p>
          The prompt memory switches decide which Create fields come back next time. Saved recipes, presets, wildcard
          lists and assistant chats are always kept. Resetting settings never touches your images.
        </p>
      </details>
      <details>
        <summary>Using ComfyUI directly</summary>
        <p>
          Latent runs on ComfyUI. Settings › Open ComfyUI opens the same engine in your browser for node-graph
          tinkering. Anything you start there shows up in the queue, and Latent waits for it to finish. Images made in
          ComfyUI don't show up in your Library.
        </p>
        <p>
          Your studio lives in %LOCALAPPDATA%\Latentv2 by default. Settings shows the exact paths. Latent never touches
          other ComfyUI installs.
        </p>
      </details>
      <details>
        <summary>Video</summary>
        <p>
          Video keeps separate drafts where you set the first and last frames, length, size and seed. Setup downloads
          the video model files, or you can add files you already have and check them. Every job double-checks its files
          before starting.
        </p>
        <p>
          Video is new and heavy, so results and speed depend a lot on your GPU. A clip marked as a playback sample is
          only there to test playback. It isn't AI output.
        </p>
      </details>
      <details>
        <summary>Licenses and installed files</summary>
        <p>
          Latent v2 is MIT licensed. The install folder includes LICENSE, THIRD-PARTY-NOTICES.txt, LICENSE.electron.txt
          and LICENSES.chromium.html. Some image libraries have their own licenses, including the LGPL. Uninstalling the
          app keeps your studio, models and images.
        </p>
      </details>
    </div>
  );
}
