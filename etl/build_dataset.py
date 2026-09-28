import csv
import json
import requests

# URL ufficiali MIMIT
URL_ANAGRAFICA = (
    "https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv"
)
URL_PREZZI = "https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv"

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

# Province su cui focalizzarci (aggiungi o togli sigle all'occorrenza)
# Se lasci la lista vuota TARGET_PROVINCE = [] prenderà TUTTA ITALIA!
TARGET_PROVINCE = ["ME", "AL"]


def fetch_csv_lines(url):
    print(f"Download in corso: {url} ...")
    resp = requests.get(url, headers=HEADERS, timeout=60)
    resp.encoding = "utf-8"
    # Salta la prima riga di metadati MIMIT e restituisce le righe pulite
    lines = resp.text.splitlines()
    return lines[1:]


def main():
    # 1. Carica l'Anagrafica Impianti
    anagrafica_lines = fetch_csv_lines(URL_ANAGRAFICA)
    reader_anagrafica = csv.DictReader(anagrafica_lines, delimiter="|")

    impianti = {}
    print("Elaborazione anagrafica impianti...")

    for row in reader_anagrafica:
        prov = row.get("Provincia", "").strip().upper()

        # Filtro geografico (se TARGET_PROVINCE è popolato)
        if TARGET_PROVINCE and prov not in TARGET_PROVINCE:
            continue

        try:
            id_imp = int(row.get("idImpianto", 0))
            lat = float(row.get("Latitudine", 0))
            lon = float(row.get("Longitudine", 0))
        except (ValueError, TypeError):
            continue

        # Scarta coordinate a zero o palesemente invalide per l'Italia
        if not (35.0 <= lat <= 48.0 and 6.0 <= lon <= 19.0):
            continue

        impianti[id_imp] = {
            "id": id_imp,
            "gestore": row.get("Bandiera", "Indipendente").strip(),
            "nome": row.get("Nome Impianto", "").strip(),
            "indirizzo": row.get("Indirizzo", "").strip(),
            "comune": row.get("Comune", "").strip(),
            "provincia": prov,
            "lat": lat,
            "lon": lon,
            "prezzo_gasolio": None,
            "data_aggiornamento": None,
        }

    print(
        f"Impianti validi mappati nelle province {TARGET_PROVINCE}: {len(impianti)}"
    )

    # 2. Carica e Unisci i Prezzi del Gasolio
    prezzi_lines = fetch_csv_lines(URL_PREZZI)
    reader_prezzi = csv.DictReader(prezzi_lines, delimiter="|")

    print("Associazione prezzi Gasolio (Self Service)...")
    abbinati = 0

    for row in reader_prezzi:
        try:
            id_imp = int(row.get("idImpianto", 0))
        except (ValueError, TypeError):
            continue

        # Ci interessa solo se l'impianto è tra quelli filtrati
        if id_imp in impianti:
            carburante = row.get("descCarburante", "").strip()
            is_self = row.get("isSelf", "").strip()

            # Vogliamo solo Gasolio Standard (escludiamo Premium/Plus) in modalità Self
            if carburante.lower() == "gasolio" and is_self == "1":
                try:
                    prezzo = float(row.get("prezzo", 0))
                except (ValueError, TypeError):
                    continue

                impianti[id_imp]["prezzo_gasolio"] = prezzo
                impianti[id_imp]["data_aggiornamento"] = row.get(
                    "dtComu", ""
                ).strip()
                abbinati += 1

    # 3. Pulizia finale: manteniamo solo gli impianti che hanno un prezzo valido comunicato
    risultati = [imp for imp in impianti.values() if imp["prezzo_gasolio"] is not None]

    # Ordiniamo per prezzo crescente (dal più economico al più caro)
    risultati.sort(key=lambda x: x["prezzo_gasolio"])

    # 4. Salvataggio in JSON compatto (direttamente per il Frontend Vite)
    import os
    from pathlib import Path
    
    output_dir = Path(__file__).parent.parent / "web" / "public" / "data"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_filepath = output_dir / "gasolio_focus.json"

    with open(output_filepath, "w", encoding="utf-8") as f:
        json.dump(risultati, f, ensure_ascii=False, indent=2)
        
    output_filename = str(output_filepath)

    print(f"\n Operazione conclusa con successo!")
    print(f"- Impianti con prezzo Gasolio Self attivo: {len(risultati)}")
    print(f"- File generato: {output_filename}")

    # Top 3 più economici
    if risultati:
        print("\n I 3 distributori più economici rilevati:")
        for top in risultati[:3]:
            print(
                f"  € {top['prezzo_gasolio']:.3f} | {top['gestore']} - {top['comune']} ({top['provincia']}) - {top['indirizzo']}"
            )


if __name__ == "__main__":
    main()