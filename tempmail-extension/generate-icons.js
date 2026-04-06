// ============================================================================
// Generate extension icons using Canvas API (run in browser console)
// ============================================================================

function generateIcons() {
  const sizes = [16, 48, 128];
  
  sizes.forEach(size => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    
    // Background
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, '#6366f1');
    gradient.addColorStop(1, '#8b5cf6');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, size * 0.2);
    ctx.fill();
    
    // Envelope icon
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = size * 0.08;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    const padding = size * 0.2;
    const w = size - padding * 2;
    const h = size * 0.6;
    const y = (size - h) / 2;
    
    // Envelope body
    ctx.strokeRect(padding, y, w, h);
    
    // Envelope flap
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(size / 2, y + h * 0.5);
    ctx.lineTo(size - padding, y);
    ctx.stroke();
    
    // Download
    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `icon${size}.png`;
      a.click();
      URL.revokeObjectURL(url);
    });
  });
}

generateIcons();
