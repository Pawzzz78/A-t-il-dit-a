`face.jpg` : portrait de l'astronaute Eileen Collins (NASA, domaine public), recadré. Sert à fabriquer des vidéos de test pour le
cadrage automatique (détection de visage).

Les tests de `test/identity.test.js` qui comparent deux personnes différentes n'ont pas d'image dans le dépôt (droits) : ils ne
sont lancés que si `FACES_TEST_OTHER_FACE=/chemin/vers/une/photo.jpg` désigne le portrait de quelqu'un d'autre.
