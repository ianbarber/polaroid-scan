import sys, json
from PIL import Image
import numpy as np
# usage: jpg2raw.py in.jpg out.raw  -> writes RGBA bytes and prints {"w":..,"h":..}
im = Image.open(sys.argv[1]).convert("RGBA")
a = np.asarray(im)
open(sys.argv[2], "wb").write(a.tobytes())
print(json.dumps({"w": im.width, "h": im.height}))
