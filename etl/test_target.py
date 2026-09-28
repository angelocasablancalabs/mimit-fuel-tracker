import csv
import io
import requests

# I vostri distributori sentinella estratti dai tuoi appunti
TARGET_IDS = {
    # Messina
    4835: "ESSO S.TERESA",
    6777: "Q8 S.TERESA",
    49329: "ENI ROCCALUMERA",
    49686: "ENI S.ALESSIO",
    44838: "Q8 A18 S.TERESA",
    9527: "Bianca ROCCALUMERA",
    3986: "ESSO TREMESTIERI",
    # Alessandria
    51468: "ENI SPINETTA MARENGO",
    63217: "Q8 CASTELCERIOLO",
    29129: "ESSO ALESSANDRIA",
}

PREZZI_URL = "https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

print("1. Scaricamento dati prezzi in corso dal MIMIT...")
response = requests.get(PREZZI_URL, headers=HEADERS, timeout=30)
response.encoding = "utf-8"

print("2. Parsing con separatore pipe '|'...")
lines = response.text.splitlines()

# Il file MIMIT ha la riga 0 con la data di estrazione e la riga 1 con le intestazioni
# Saltiamo la prima riga se contiene metadati
reader = csv.DictReader(lines[1:], delimiter="|")

print(
    f"\n{'ID':<8} | {'NOME/ZONA':<22} | {'CARBURANTE':<10} | {'PREZZO':<8} | {'SELF':<5} | {'DATA/ORA COMU'}"
)
print("-" * 75)

trovati = 0
for row in reader:
    try:
        id_imp = int(row.get("idImpianto", 0))
    except (ValueError, TypeError):
        continue

    if id_imp in TARGET_IDS:
        carburante = row.get("descCarburante", "")
        # Filtriamo solo Gasolio
        if "gasolio" in carburante.lower():
            prezzo = row.get("prezzo", "")
            is_self = "Sì" if row.get("isSelf") == "1" else "No"
            dt_comu = row.get("dtComu", "")
            nome_target = TARGET_IDS[id_imp]

            print(
                f"{id_imp:<8} | {nome_target:<22} | {carburante:<10} | {prezzo:<8} | {is_self:<5} | {dt_comu}"
            )
            trovati += 1

print("-" * 75)
print(f"Elaborazione completata. Trovati {trovati} record di gasolio per gli impianti target.")