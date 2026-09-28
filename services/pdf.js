const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

async function drawBackground(doc, urlOrPath) {
  if (urlOrPath && urlOrPath.startsWith('http')) {
      try {
          // 🎯 MAGIE : On force Cloudinary à envoyer un format JPG pour ne pas faire planter PDFKit
          let finalUrl = urlOrPath;
          if (finalUrl.includes('cloudinary.com') && !finalUrl.includes('f_jpg')) {
              finalUrl = finalUrl.replace('/upload/', '/upload/f_jpg/');
          }

          const response = await fetch(finalUrl);
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          doc.image(buffer, 0, 0, { width: 595, height: 842 });
      } catch (e) {
          console.error("Erreur téléchargement image fond PDF:", e);
          doc.rect(0, 0, 595, 842).fill('#1e3a8a');
      }
  } else {
      const cleanImageName = urlOrPath && urlOrPath !== '' ? (urlOrPath.startsWith('/') ? urlOrPath.substring(1) : urlOrPath) : 'cadeau-background.jpg';
      const finalImagePath = path.join(process.cwd(), 'public', cleanImageName);
      if (fs.existsSync(finalImagePath)) {
          doc.image(finalImagePath, 0, 0, { width: 595, height: 842 });
      } else {
          doc.rect(0, 0, 595, 842).fill('#1e3a8a'); 
      }
  }
}


async function generatePDFBuffer(voucher) {
  return new Promise(async (resolve, reject) => { 
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const backgroundSrc = voucher.pdf_background_url || 'cadeau-background.jpg';
    await drawBackground(doc, backgroundSrc);

    // 1. Nom de l'acheteur (Parfaitement centré avec X = 0 et width = 595)
    const buyerY = 184 * 2.834;
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(14).text(String(voucher.buyer_name || '').toUpperCase(), 0, buyerY, { align: 'center', width: 595 });
    
    // 2. Code du bon
    const codeX = 90 * 2.834;
    const codeY = 217 * 2.834; 
    doc.fillColor('#f026b8').font('Helvetica-Bold').fontSize(14).text(String(voucher.code), codeX, codeY, { characterSpacing: 2 });

    // 3. Texte dynamique (Taille 10, zone de texte élargie à 535 pour garantir 75 signes)
    const textY = 264 * 2.834; 
    if (voucher.custom_line_1) {
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10).text(String(voucher.custom_line_1).toUpperCase(), 30, textY, { width: 535, align: 'center' });
    }
    if (voucher.custom_line_2) {
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10).text(String(voucher.custom_line_2).toUpperCase(), 30, textY + 15, { width: 535, align: 'center' });
    }
    if (voucher.custom_line_3) {
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10).text(String(voucher.custom_line_3).toUpperCase(), 30, textY + 30, { width: 535, align: 'center' });
    }

    // Date de validité — depuis valid_until si disponible, sinon +18 mois par défaut
    const dateV = voucher.valid_until ? new Date(voucher.valid_until) : (() => { const d = new Date(); d.setMonth(d.getMonth() + 18); return d; })();
    const validUntil = dateV.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const dateY = codeY + 14 + (13 * 2.834);
    doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(8).text(`VALABLE JUSQU'AU : ${validUntil.toUpperCase()}`, 0, dateY, { align: 'center', width: 595 });

    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8').text('Fluide Parapente - La Clusaz | www.fluide-parapente.fr', 0, 815, { align: 'center', width: 595 });

    doc.end();
  });
}


module.exports = { drawBackground, generatePDFBuffer };
